#!/usr/bin/env bun
// Harness-agnostic command-line front end to the research-gateway REST door
// (src/routes/research.ts). A plain HTTP client — no dependency on the MCP layer — so
// Codex, OpenCode, Hermes, cron and scripts can submit and wait on a job without an MCP
// client. Talks to `RESEARCH_GATEWAY_URL ?? http://127.0.0.1:7780`, bearer
// `RESEARCH_GATEWAY_TOKEN` (or the macOS Keychain fallback).
//
// The argv -> request-body mapping and the exit-code mapping are exported pure functions so
// bin/research.test.ts can pin them without spawning a server; the only I/O here is fetch,
// the `--context @file` read, and the Keychain bearer lookup. The wait has no wall-clock
// ceiling (rules/agent-limits.md): the job is durable server-side, so a transient poll
// failure is retried with backoff rather than aborting the wait.

import { readFileSync } from 'node:fs'
import type { Depth, JobProgress, JobStatus, ResearchReport } from '../src/agent/schema.js'

const DEFAULT_URL = 'http://127.0.0.1:7780'
const POLL_MS = 2_000
// A transient poll failure (a restart window, a dropped connection) is retried with backoff
// rather than aborting the wait — the job itself is durable server-side for the whole
// retention window, so the wait can always be resumed from the job id.
const MAX_POLL_RETRIES = 10
const POLL_RETRY_BASE_MS = 2_000
const POLL_RETRY_CAP_MS = 10_000

// ── Errors (message → exit code) ─────────────────────────────────────────────────

class CliError extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

/** Usage error, or a submit the server refused (429/503 admission, 401/403 auth) → exit 2. */
class CliUsageError extends CliError {
  constructor(message: string) {
    super(message, 2)
    this.name = 'CliUsageError'
  }
}

/** The server answered with a job error or a 5xx → exit 1. */
class CliServerError extends CliError {
  constructor(message: string) {
    super(message, 1)
    this.name = 'CliServerError'
  }
}

/** The server could not be reached at all (connection refused, DNS, …) → exit 3. */
class CliUnreachableError extends CliError {
  constructor(message: string) {
    super(message, 3)
    this.name = 'CliUnreachableError'
  }
}

// ── Commands (pure types) ────────────────────────────────────────────────────────

/** `--context <text>` passes through verbatim; `--context @file` reads a file. */
export type ContextSpec = { kind: 'text'; text: string } | { kind: 'file'; path: string }

export interface SubmitCommand {
  kind: 'submit'
  query: string
  depth?: Depth
  context?: ContextSpec
  idempotencyKey?: string
}
export interface WaitCommand {
  kind: 'wait'
  jobId: string
}
export interface StatusCommand {
  kind: 'status'
  jobId: string
}
export interface CancelCommand {
  kind: 'cancel'
  jobId: string
}
export interface HelpCommand {
  kind: 'help'
}
export type Command = SubmitCommand | WaitCommand | StatusCommand | CancelCommand | HelpCommand

export interface Options {
  json: boolean
  noWait: boolean
}
export interface Parsed {
  command: Command
  options: Options
}

// ── Argument parsing (pure) ──────────────────────────────────────────────────────

const DEPTHS: readonly Depth[] = ['quick', 'standard', 'deep']

function parseDepth(raw: string): Depth {
  if ((DEPTHS as readonly string[]).includes(raw)) return raw as Depth
  throw new CliUsageError(`--depth must be one of quick | standard | deep, got: ${raw}`)
}

export function parseArgs(argv: string[]): Parsed {
  const options: Options = { json: false, noWait: false }
  const positionals: string[] = []
  let depth: Depth | undefined
  let context: ContextSpec | undefined
  let idempotencyKey: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--no-wait') {
      options.noWait = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      return { command: { kind: 'help' }, options }
    }

    const { name, inlineValue } = splitFlag(arg)
    if (name !== null) {
      // `--flag=value` carries its value inline; `--flag value` takes the next argv element.
      let value: string
      if (inlineValue !== null) {
        value = inlineValue
      } else {
        const next = argv[i + 1]
        if (next === undefined) throw new CliUsageError(`${name} requires a value`)
        value = next
        i++
      }
      switch (name) {
        case '--depth':
          depth = parseDepth(value)
          break
        case '--context':
          context = parseContext(value)
          break
        case '--key':
          if (value.length === 0 || value.length > 200) {
            throw new CliUsageError('--key must be 1..200 characters')
          }
          idempotencyKey = value
          break
        default:
          throw new CliUsageError(`unknown flag ${name}`)
      }
      continue
    }

    if (arg.startsWith('-') && arg !== '-') throw new CliUsageError(`unknown flag ${arg}`)
    positionals.push(arg)
  }

  const [first, ...rest] = positionals
  if (first === undefined) throw new CliUsageError("no query given (see 'research --help')")

  if (first === 'wait' || first === 'status' || first === 'cancel') {
    if (rest.length !== 1 || (rest[0] ?? '').length === 0) {
      throw new CliUsageError(`research ${first} requires exactly one <jobId>`)
    }
    return { command: { kind: first, jobId: rest[0] as string }, options }
  }

  if (rest.length > 0) {
    throw new CliUsageError('a submit takes one query argument (quote it if it contains spaces)')
  }
  return {
    command: {
      kind: 'submit',
      query: first,
      ...(depth !== undefined ? { depth } : {}),
      ...(context !== undefined ? { context } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    },
    options,
  }
}

function splitFlag(arg: string): { name: string | null; inlineValue: string | null } {
  if (!arg.startsWith('--') || arg === '--') return { name: null, inlineValue: null }
  const eq = arg.indexOf('=')
  if (eq === -1) return { name: arg, inlineValue: null }
  return { name: arg.slice(0, eq), inlineValue: arg.slice(eq + 1) }
}

function parseContext(value: string): ContextSpec {
  if (value.length === 0) throw new CliUsageError('--context requires non-empty text or @file')
  if (value.startsWith('@')) {
    const path = value.slice(1)
    if (path.length === 0) throw new CliUsageError('--context @file requires a path')
    return { kind: 'file', path }
  }
  return { kind: 'text', text: value }
}

/** Resolve a `--context` spec to its text: a leading `@` reads a file, anything else is
 *  passed through verbatim. The `read` seam keeps the pure mapping testable without disk. */
export function resolveContextText(
  spec: ContextSpec | undefined,
  read: (path: string) => string,
): string | undefined {
  if (spec === undefined) return undefined
  if (spec.kind === 'text') return spec.text
  try {
    return read(spec.path)
  } catch (err) {
    throw new CliUsageError(
      `could not read --context file ${spec.path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** The exact POST /research body a parsed submit sends, given the resolved context text and
 *  idempotency key. */
export function submitRequestBody(
  command: SubmitCommand,
  resolved: { context?: string; idempotencyKey: string },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: command.query,
    idempotencyKey: resolved.idempotencyKey,
  }
  if (command.depth !== undefined) body['depth'] = command.depth
  if (resolved.context !== undefined) body['context'] = resolved.context
  return body
}

/** Exit code for a job that reached a terminal state: 0 done, 1 error or cancelled. */
export function exitCodeFor(status: JobStatus): number {
  return status === 'done' ? 0 : 1
}

function isTerminal(status: JobStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled'
}

// ── Rendering (readable output for humans) ───────────────────────────────────────

/** The stderr side of a finished job: status, warnings and the full `unverified` list — a
 *  non-`ok` status and `unverified` must always be surfaced, never just the report string. */
export function reportSummaryLines(report: ResearchReport): string[] {
  const header = [`status: ${report.status}`]
  if (report.warnings.length > 0) header.push(`warnings: ${report.warnings.length}`)
  header.push(`unverified: ${report.unverified.length}`)
  const lines = [header.join(' | ')]
  for (const warning of report.warnings) lines.push(`warning: ${warning}`)
  for (const item of report.unverified) {
    lines.push(`unverified: ${item.topic}${item.url ? ` (${item.url})` : ''} — ${item.reason}`)
  }
  return lines
}

function emitResult(io: CliIo, jobId: string, job: JobView, options: Options): void {
  if (options.json) {
    // GET /research/:jobId does not echo the id; a script piping --json needs it to re-query.
    io.out(`${JSON.stringify({ jobId, ...job }, null, 2)}\n`)
    return
  }
  if (job.status === 'error') {
    io.err(`research: job error: ${job.error ?? 'unknown error'}\n`)
    return
  }
  if (job.status === 'cancelled') {
    io.err(`research: job cancelled\n`)
    return
  }
  if (job.result) {
    for (const line of reportSummaryLines(job.result)) io.err(`${line}\n`)
    io.out(`${job.result.report}\n`)
    return
  }
  io.err('research: job is done but carried no result\n')
}

function renderJobHuman(job: JobView): string {
  if (job.status === 'error') return `status: error\nerror: ${job.error ?? 'unknown error'}`
  if (job.status === 'cancelled') return `status: cancelled`
  if (job.status === 'done' && job.result) {
    return [`status: done`, ...reportSummaryLines(job.result), '', job.result.report].join('\n')
  }
  return liveStatusLine(job, Date.now())
}

const secs = (ms: number): string => `${Math.round(ms / 1000)}s`

/** One line for a queued/running job: where it is and how long it has been there, against the
 *  measured p50/p90 for its depth — enough to tell "queued behind others" from "stuck". */
export function liveStatusLine(job: JobView, now: number): string {
  const parts = [`status: ${job.status}`]
  if (job.queuePosition != null) parts.push(`queue position ${job.queuePosition}`)
  if (job.progress != null) {
    const { phase, round, workers } = job.progress
    parts.push(phase === 'researching' ? `researching round ${round}, workers ${workers.done}/${workers.total}` : phase)
  }
  const since = job.status === 'running' ? job.startedAt : job.submittedAt
  if (since != null) {
    const elapsed = `${job.status === 'running' ? 'running' : 'waiting'} ${secs(now - Date.parse(since))}`
    const typical = job.typicalDurationMs
    parts.push(
      typical && job.status === 'running'
        ? `${elapsed} (typical p50 ${secs(typical.p50)}, p90 ${secs(typical.p90)})`
        : elapsed,
    )
  }
  return parts.join(' · ')
}

// ── HTTP client (the only I/O against the server) ────────────────────────────────

/** The narrow fetch shape the CLI needs — narrower than `typeof fetch` so a test mock is a
 *  plain function, not a cast through `unknown`. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface HttpResponse {
  status: number
  data: unknown
  retryAfter: string | null
}

async function request(
  fetchFn: FetchLike,
  base: string,
  path: string,
  init?: RequestInit,
): Promise<HttpResponse> {
  let res: Response
  try {
    res = await fetchFn(base + path, init)
  } catch (err) {
    // An abort we issued ourselves is not "unreachable" — let it propagate.
    if (err instanceof Error && err.name === 'AbortError') throw err
    throw new CliUnreachableError(`research-gateway unreachable at ${base}`)
  }
  const text = await res.text()
  let data: unknown
  try {
    data = text.length > 0 ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: res.status, data, retryAfter: res.headers.get('retry-after') }
}

export interface JobView {
  status: JobStatus
  result: ResearchReport | null
  error: string | null
  // Live fields (GET /research/:jobId). Optional so an older server's response still parses.
  submittedAt?: string
  startedAt?: string | null
  queuePosition?: number | null
  progress?: JobProgress | null
  typicalDurationMs?: { p50: number; p90: number }
}

interface SubmitResult {
  jobId: string
  status: JobStatus
}

function refusalMessage(r: HttpResponse): string {
  const data = r.data as { error?: string }
  const base = data.error ?? `submit refused with status ${r.status}`
  return r.retryAfter !== null ? `${base} (retry after ${r.retryAfter}s)` : base
}

async function submitJob(
  fetchFn: FetchLike,
  base: string,
  token: string,
  body: Record<string, unknown>,
): Promise<SubmitResult> {
  const r = await request(fetchFn, base, '/research', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (r.status === 200) {
    const data = r.data as { jobId?: unknown; status?: unknown }
    if (typeof data.jobId === 'string' && typeof data.status === 'string') {
      return { jobId: data.jobId, status: data.status as JobStatus }
    }
    throw new CliServerError('submit succeeded but the response carried no jobId')
  }
  // 429/503 (admission) and 401/403 (auth) are both "refused, fix the call" → exit 2; any
  // other 4xx is a usage error → exit 2; 5xx is the server's fault → exit 1.
  if (r.status === 429 || r.status === 503 || r.status === 401 || r.status === 403) {
    throw new CliUsageError(refusalMessage(r))
  }
  const data = r.data as { error?: string }
  const message = data.error ?? `submit failed with status ${r.status}`
  throw r.status >= 400 && r.status < 500 ? new CliUsageError(message) : new CliServerError(message)
}

/** Retry a submit on a transport failure with the SAME body (and therefore the same
 *  idempotency key), so a request that reached the server before the connection dropped
 *  returns the original job rather than starting a second. */
async function submitWithRetry(
  ctx: CliContext,
  io: CliIo,
  base: string,
  token: string,
  body: Record<string, unknown>,
): Promise<SubmitResult> {
  const wait = ctx.sleepFn ?? sleep
  let failures = 0
  for (;;) {
    try {
      return await submitJob(ctx.fetchFn, base, token, body)
    } catch (err) {
      if (err instanceof CliUnreachableError && failures < MAX_POLL_RETRIES) {
        failures++
        if (failures === 1) io.err(`research: submit failed (${err.message}) — retrying…\n`)
        await wait(Math.min(POLL_RETRY_BASE_MS * 2 ** (failures - 1), POLL_RETRY_CAP_MS))
        continue
      }
      throw err
    }
  }
}

async function fetchJob(
  fetchFn: FetchLike,
  base: string,
  token: string,
  jobId: string,
): Promise<JobView> {
  const r = await request(fetchFn, base, `/research/${encodeURIComponent(jobId)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (r.status === 404) throw new CliServerError(`job not found: ${jobId}`)
  if (r.status === 401 || r.status === 403) throw new CliUsageError('unauthorized — check RESEARCH_GATEWAY_TOKEN')
  if (r.status !== 200) throw new CliServerError(`job fetch failed (${r.status})`)
  return r.data as JobView
}

async function cancelRemoteJob(
  fetchFn: FetchLike,
  base: string,
  token: string,
  jobId: string,
): Promise<SubmitResult> {
  const r = await request(fetchFn, base, `/research/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
  if (r.status === 404) throw new CliServerError(`job not found: ${jobId}`)
  if (r.status === 401 || r.status === 403) throw new CliUsageError('unauthorized — check RESEARCH_GATEWAY_TOKEN')
  if (r.status !== 200) {
    const data = r.data as { error?: string } | null
    throw new CliServerError(data?.error ?? `cancel failed (${r.status})`)
  }
  return r.data as SubmitResult
}

// ── Execution ────────────────────────────────────────────────────────────────────

export interface CliIo {
  out: (s: string) => void
  err: (s: string) => void
}

export interface CliContext {
  fetchFn: FetchLike
  env: Record<string, string | undefined>
  /** Resolve the bearer token: env first, then the Keychain. Injected in tests. */
  resolveToken: () => string | null
  /** Overrides the real file read — tests inject one so `--context @file` needs no disk. */
  readFile?: (path: string) => string
  /** Overrides the real `setTimeout`-based delay so a poll interval or retry backoff costs
   *  no wall-clock time under test. Defaults to `sleep`. */
  sleepFn?: (ms: number) => Promise<void>
}

/** Bearer resolution: `RESEARCH_GATEWAY_TOKEN`, else the macOS Keychain. Exported so the
 *  precedence is testable without touching either. */
export function resolveToken(
  env: Record<string, string | undefined>,
  keychain: () => string | null,
): string | null {
  const fromEnv = env['RESEARCH_GATEWAY_TOKEN']?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return keychain()
}

function keychainToken(): string | null {
  try {
    const proc = Bun.spawnSync(['security', 'find-generic-password', '-s', 'research-gateway-token', '-w'])
    if (proc.exitCode !== 0) return null
    const token = proc.stdout.toString().trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

/** Run the CLI against an injected fetch/token resolver — the seam tests use to avoid a live
 *  server. Returns the process exit code. */
export async function run(argv: string[], ctx: CliContext, io: CliIo): Promise<number> {
  const base = (ctx.env['RESEARCH_GATEWAY_URL'] ?? DEFAULT_URL).replace(/\/+$/, '')
  try {
    const { command, options } = parseArgs(argv)
    return await execute(command, options, ctx, io, base)
  } catch (err) {
    if (err instanceof CliError) {
      io.err(`research: ${err.message}\n`)
      if (err.code === 2) io.err("Try 'research --help'.\n")
      return err.code
    }
    io.err(`research: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

async function execute(
  command: Command,
  options: Options,
  ctx: CliContext,
  io: CliIo,
  base: string,
): Promise<number> {
  if (command.kind === 'help') {
    io.out(`${USAGE}\n`)
    return 0
  }

  const token = ctx.resolveToken()
  if (token === null || token.length === 0) {
    throw new CliUsageError(
      'no bearer token: set RESEARCH_GATEWAY_TOKEN, or store it in the macOS Keychain as generic password service "research-gateway-token"',
    )
  }

  switch (command.kind) {
    case 'submit': {
      const readFile = ctx.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
      const contextText = resolveContextText(command.context, readFile)
      // Always send a key, generating one when the caller passed none: a CLI-level retry of
      // the submit (a dropped connection before the response arrived) then resolves to the
      // original job instead of a duplicate.
      const idempotencyKey = command.idempotencyKey ?? crypto.randomUUID()
      const body = submitRequestBody(command, {
        ...(contextText !== undefined ? { context: contextText } : {}),
        idempotencyKey,
      })
      const { jobId } = await submitWithRetry(ctx, io, base, token, body)
      if (options.noWait) {
        if (options.json) io.out(`${JSON.stringify({ jobId }, null, 2)}\n`)
        else io.out(`${jobId}\n`)
        return 0
      }
      return waitForJob(ctx, io, base, token, jobId, options)
    }
    case 'wait':
      return waitForJob(ctx, io, base, token, command.jobId, options)
    case 'status': {
      const job = await fetchJob(ctx.fetchFn, base, token, command.jobId)
      if (options.json) io.out(`${JSON.stringify({ jobId: command.jobId, ...job }, null, 2)}\n`)
      else io.out(`${renderJobHuman(job)}\n`)
      return isTerminal(job.status) ? exitCodeFor(job.status) : 0
    }
    case 'cancel': {
      // Idempotent server-side: a job that already finished comes back with its own status,
      // which is reported as-is — exit 0 either way, the job is no longer running.
      const { status } = await cancelRemoteJob(ctx.fetchFn, base, token, command.jobId)
      if (options.json) io.out(`${JSON.stringify({ jobId: command.jobId, status }, null, 2)}\n`)
      else io.out(`${command.jobId} ${status}\n`)
      return 0
    }
  }
}

/** Poll until terminal, with no wall-clock ceiling. Only a transient transport failure is
 *  retried — a real server error (bad status, malformed body) would fail identically on the
 *  next attempt. After MAX_POLL_RETRIES consecutive failures the wait gives up (exit 3); the
 *  job keeps running server-side and `research wait <jobId>` resumes it. */
async function waitForJob(
  ctx: CliContext,
  io: CliIo,
  base: string,
  token: string,
  jobId: string,
  options: Options,
): Promise<number> {
  const wait = ctx.sleepFn ?? sleep
  let pollFailures = 0

  for (;;) {
    let job: JobView
    try {
      job = await fetchJob(ctx.fetchFn, base, token, jobId)
    } catch (err) {
      if (err instanceof CliUnreachableError && pollFailures < MAX_POLL_RETRIES) {
        pollFailures++
        if (pollFailures === 1) io.err(`research: poll failed (${err.message}) — retrying…\n`)
        await wait(Math.min(POLL_RETRY_BASE_MS * 2 ** (pollFailures - 1), POLL_RETRY_CAP_MS))
        continue
      }
      throw err
    }
    if (pollFailures > 0) {
      io.err(`research: poll recovered after ${pollFailures} failed attempt(s)\n`)
      pollFailures = 0
    }

    if (isTerminal(job.status)) {
      if (job.status === 'error' && !options.json) {
        io.err(`research: job ${jobId} error: ${job.error ?? 'unknown error'}\n`)
      }
      emitResult(io, jobId, job, options)
      return exitCodeFor(job.status)
    }
    await wait(POLL_MS)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Help ─────────────────────────────────────────────────────────────────────────

const USAGE = `research — command-line client for the research-gateway REST door

Usage:
  research "<query>" [--depth quick|standard|deep] [--context <text>|@file]
                     [--key <idempotencyKey>] [--json] [--no-wait]
  research wait <jobId> [--json]
  research status <jobId> [--json]
  research cancel <jobId> [--json]

Submits to POST /research and (by default) waits by polling GET /research/:jobId until the
job is done, then prints the report markdown to stdout and status/warnings/unverified to
stderr. --no-wait prints only the jobId. --json prints the full job JSON. wait resumes a
known job id without re-submitting; status is a single non-blocking check; cancel stops a
queued or running job (idempotent — an already-finished job is left as it is).

Environment:
  RESEARCH_GATEWAY_URL    base URL (default http://127.0.0.1:7780)
  RESEARCH_GATEWAY_TOKEN  bearer token; falls back to the macOS Keychain generic password
                          service "research-gateway-token".

Exit codes: 0 done · 1 job error or cancelled · 2 usage/auth/refused · 3 unreachable.`

if (import.meta.main) {
  process.exitCode = await run(
    process.argv.slice(2),
    {
      fetchFn: fetch,
      env: process.env,
      resolveToken: () => resolveToken(process.env, keychainToken),
    },
    {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    },
  )
}
