// The I/O boundary for the human-solve escalation path — imports env, spawns processes, so
// (like ytdlp.ts/pdf.ts/brain-search.ts) it is not itself unit-tested. All the orchestration
// logic (queuing, admission, escalation, outcome recording) lives in human-solver.ts, which
// takes every I/O boundary as an injected port and carries its own tests; this file only builds
// the REAL ports (ssh+JXA, Bun.spawn bin/solver.ts, the cleared-mode semaphore) and wires them
// into `createHumanSolver`.
//
// When a page is behind a Cloudflare/anti-bot challenge, the fetch chain calls `humanSolver`
// (the HumanSolve port, owned by fetch-chain.ts and imported type-only below — the other half
// of this work owns that file). Two things happen, never on the same machine:
//   - The browser that actually fetches the page is bin/solver.ts, spawned LOCALLY on the
//     mini (never over ssh) — cf_clearance must be issued to the IP later fetches also use,
//     which is the mini's, and the MacBook is an IU-managed device on a corporate network that
//     must never be the fetch egress (measured 2026-09-26: TLS resets against
//     Cloudflare-fronted example.com from that network).
//   - The HUMAN still solves visually, on the MacBook, by opening Screen Sharing into the
//     mini's own console session — this file only asks them to, over ssh + a fixed
//     `osascript -l JavaScript` invocation. The MacBook never touches the target page.

import { join } from 'node:path'
import { env } from '../env.js'
import { createSemaphore } from '../lib/semaphore.js'
import { readCappedText } from './pdf-extract.js'
import { createHumanSolveState, parseSolverOutput, parseDialogOutput, type SolverOutput } from './human-solve-state.js'
import { createHumanSolver, SOLVER_SAFETY_MARGIN_MS, type HumanSolverPorts } from './human-solver.js'

// The port's shape is owned by fetch-chain.ts — a type-only import, so no runtime cycle.
import type { HumanSolve, HumanSolveRequest } from './fetch-chain.js'
import { log } from '../lib/log.js'

// Bounds a spawned process's stdout/stderr the same way ytdlp.ts/pdf.ts bound their spawns —
// far above anything real (solver.ts itself caps html at 5 MB; the dialog prints one short
// JSON line), guarding only against a pathological response.
const MAX_STDOUT_BYTES = 8 * 1024 * 1024

// bin/solver.ts is spawned directly (no ssh — it runs on this same machine), resolved from
// this file's own location so it works regardless of cwd.
const SOLVER_SCRIPT_PATH = join(import.meta.dir, '../../bin/solver.ts')

// The dialog's own `givingUpAfter` (seconds, baked into the JXA program below) plus generous
// ssh/osascript round-trip overhead — independent of HUMAN_SOLVE_WAIT_MS, which budgets the
// solve flow as a whole (the warm step + the dialog + the local solve), not just the prompt.
const DIALOG_GIVE_UP_S = 90
const DIALOG_SSH_TIMEOUT_MS = 110_000

// Fixed remote command — never interpolated with request data. The JXA *program* (built per
// call, with host/reason/viewUrl embedded only as JSON.stringify'd JS string literals) goes
// over stdin, exactly like solver.ts's request JSON.
const DIALOG_REMOTE_CMD = 'osascript -l JavaScript -'

// Social-engineering hardening: the host, the target URL's path, and the block reason all ride
// in on an attacker-influenced (LLM-chosen) request, and all end up as plain text in a dialog
// the human reads over Screen Sharing. Bounding their length bounds how much of that text an
// attacker controls.
const DIALOG_HOST_DISPLAY_MAX_LEN = 80
const DIALOG_PATH_DISPLAY_MAX_LEN = 80
const DIALOG_REASON_DISPLAY_MAX_LEN = 80

const MAX_CONCURRENT_CLEARED = 2
const clearedSlots = createSemaphore(MAX_CONCURRENT_CLEARED, env.HUMAN_SOLVE_WAIT_MS)

// Shell-quotes a trusted config string (HUMAN_SOLVE_VIEW_URL, never attacker data) for
// `doShellScript`'s `open <url>` — defense in depth even though the value is never
// user-influenced.
function shQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

// Bounds how much attacker-influenced text (the challenged host, the target URL's path, or the
// block reason) ever reaches the dialog text a human reads over Screen Sharing — a long or
// crafted string is a social-engineering surface, not just a cosmetic overflow.
function truncateForDisplay(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : `${value.slice(0, maxLen)}…`
}

function pathForDisplay(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

function buildDialogProgram(args: { host: string; path: string; reason: string; viewUrl: string }): string {
  const hostLit = JSON.stringify(args.host)
  const pathLit = JSON.stringify(args.path)
  const reasonLit = JSON.stringify(args.reason)
  const shQuotedViewUrl = JSON.stringify(shQuote(args.viewUrl))
  return `
(function () {
  var app = Application.currentApplication()
  app.includeStandardAdditions = true
  var host = ${hostLit}
  var path = ${pathLit}
  var reason = ${reasonLit}
  var msg = host + path + " is behind a " + reason + ". Open the mini's screen to solve it?"
  var result
  try {
    result = app.displayDialog(msg, {
      withTitle: "research-gateway",
      buttons: ["Skip", "Open"],
      defaultButton: "Skip",
      givingUpAfter: ${DIALOG_GIVE_UP_S},
    })
  } catch (e) {
    // AppleScript/JXA's "user cancelled" is error -128 (Command-Period, Escape, or a
    // Cancel-named button) — only THAT is a real "declined" (the human saw the dialog and
    // dismissed it). Any other displayDialog failure (no GUI session, Automation permission
    // not granted, System Events not authorized, ...) says nothing about the HOST, so it is
    // reported as a distinct reason human-solver.ts suppresses globally and briefly, the same
    // way an unreachable MacBook is, rather than the host's own 6h suppression.
    //
    // e.errorNumber mirrors AppleScript's 'error number' on a caught Standard Additions/
    // Automation error — unverified live (this path can't be exercised without popping a real
    // dialog on the owner's screen, which the task explicitly forbids); falls back to the
    // generic reason if the property isn't there.
    var num = e && typeof e.errorNumber === "number" ? e.errorNumber : undefined
    if (num === -128) return JSON.stringify({ ok: false, reason: "declined" })
    return JSON.stringify({ ok: false, reason: "dialog_error" })
  }
  if (result.gaveUp) return JSON.stringify({ ok: false, reason: "unanswered" })
  if (result.buttonReturned === "Open") {
    // app.openLocation exists on StandardAdditions here (verified live, 2026-09-26, over
    // ssh -o BatchMode=yes iumac 'osascript -l JavaScript -': typeof app.openLocation ===
    // "function", checked WITHOUT calling it — calling it to find out whether it actually
    // handles a vnc:// URL would open Screen Sharing on the owner's screen sight-unseen).
    // Kept on the doShellScript("open ...") layer instead, since that path is the one already
    // proven for this scheme: shQuote defends a trusted, never-attacker-influenced config
    // string (HUMAN_SOLVE_VIEW_URL) against shell metacharacters, and open is the same CLI
    // the owner's own Finder uses to dispatch a URL by scheme.
    try {
      app.doShellScript("open " + ${shQuotedViewUrl})
    } catch (e) {
      // best effort — the dialog answer is what matters, not whether \`open\` itself succeeded
    }
    return JSON.stringify({ ok: true })
  }
  return JSON.stringify({ ok: false, reason: "declined" })
})()
`
}

interface SpawnedResult {
  stdout: string
  stderr: string
  code: number | null
  aborted: boolean
  hardTimedOut: boolean
}

// One spawn→stdin→abort→capped-read→exit dance, shared by promptUser (ssh) and runSolver
// (bin/solver.ts) — leans on the same Bun `proc.signalCode` trap ytdlp.ts/pdf.ts document too
// (true for both a real kill AND a clean fast exit alike). Bun's own `timeout`/`killSignal`
// spawn options are deliberately NOT used here: bin/solver.ts intercepts SIGTERM itself and
// exits cleanly (an exit code, not a signal-terminated process), which made that ambiguous for
// its caller. `hardTimedOut` is instead a flag OWNED by this function's own timer, set only
// when IT fired the kill — unambiguous no matter how the child reacts to the signal. `aborted`
// is the same idea for `signal`: true only when its listener fired the kill, never inferred
// from the exit code.
async function runSpawned(args: { cmd: string[]; stdin: string; timeoutMs: number; signal: AbortSignal }): Promise<SpawnedResult> {
  if (args.signal.aborted) {
    return { stdout: '', stderr: '', code: null, aborted: true, hardTimedOut: false }
  }

  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
  let aborted = false
  const onAbort = (): void => {
    aborted = true
    proc?.kill('SIGTERM')
  }
  // Registered BEFORE spawning, so an abort landing in the gap between this call and the spawn
  // below still results in a kill instead of a process nobody ever cancels.
  args.signal.addEventListener('abort', onAbort, { once: true })
  if (args.signal.aborted) {
    args.signal.removeEventListener('abort', onAbort)
    return { stdout: '', stderr: '', code: null, aborted: true, hardTimedOut: false }
  }

  proc = Bun.spawn(args.cmd, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  proc.stdin.write(args.stdin)
  await proc.stdin.end()

  let hardTimedOut = false
  const hardTimer = setTimeout(() => {
    hardTimedOut = true
    proc?.kill('SIGTERM')
  }, args.timeoutMs)

  try {
    const [stdout, stderr] = await Promise.all([
      readCappedText(proc.stdout, MAX_STDOUT_BYTES),
      readCappedText(proc.stderr, MAX_STDOUT_BYTES),
    ])
    const code = await proc.exited
    return { stdout, stderr, code, aborted, hardTimedOut }
  } finally {
    clearTimeout(hardTimer)
    args.signal.removeEventListener('abort', onAbort)
  }
}

// Asks the human, on the MacBook, whether to open Screen Sharing into the mini and solve a
// challenge there. Never touches the target page or the solver Chrome itself. Purely an I/O
// boundary — no business logging or suppression-state writes here; human-solver.ts's core does
// all of that from the single reason this returns.
const promptUser: HumanSolverPorts['promptUser'] = async (req) => {
  const sshHost = env.HUMAN_SOLVE_SSH_HOST
  if (!sshHost) return { ok: false, reason: 'error' } // unreachable: humanSolver is undefined below when this is unset
  if (req.signal.aborted) return { ok: false, reason: 'aborted' }

  const viewUrl = env.HUMAN_SOLVE_VIEW_URL ?? 'vnc://mini'
  const program = buildDialogProgram({
    host: truncateForDisplay(req.host, DIALOG_HOST_DISPLAY_MAX_LEN),
    path: truncateForDisplay(pathForDisplay(req.url), DIALOG_PATH_DISPLAY_MAX_LEN),
    reason: truncateForDisplay(req.reason, DIALOG_REASON_DISPLAY_MAX_LEN),
    viewUrl,
  })

  try {
    const spawned = await runSpawned({
      cmd: ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshHost, DIALOG_REMOTE_CMD],
      stdin: program,
      timeoutMs: DIALOG_SSH_TIMEOUT_MS,
      signal: req.signal,
    })

    if (spawned.aborted) return { ok: false, reason: 'aborted' }
    if (spawned.hardTimedOut) return { ok: false, reason: 'unanswered' }
    // ssh's own exit code for "could not connect at all".
    if (spawned.code === 255) return { ok: false, reason: 'unreachable' }
    if (spawned.code !== 0) return { ok: false, reason: 'error' }

    return parseDialogOutput(spawned.stdout)
  } catch {
    return { ok: false, reason: 'error' }
  }
}

function toSolverOutput(spawned: SpawnedResult): SolverOutput {
  if (spawned.aborted) return { ok: false, reason: 'aborted' }
  if (spawned.hardTimedOut) return { ok: false, reason: 'timeout' }
  if (spawned.code !== 0) return { ok: false, reason: 'error' }
  return parseSolverOutput(spawned.stdout)
}

// Runs bin/solver.ts LOCALLY on the mini, in one of the three protocol modes (see its own
// header). Purely an I/O boundary, same as promptUser above — no logging, no state writes.
const runSolver: HumanSolverPorts['runSolver'] = async (mode, req, timeoutMs) => {
  if (req.signal.aborted) return { ok: false, reason: 'aborted' }
  const requestBody = JSON.stringify({ v: 1, mode, url: req.url, timeoutMs, proxyPort: env.HUMAN_SOLVE_PROXY_PORT })
  try {
    const spawned = await runSpawned({
      cmd: [process.execPath, SOLVER_SCRIPT_PATH],
      stdin: requestBody,
      // A hard outer safety net past bin/solver.ts's own internal deadline (it is handed the
      // same `timeoutMs` and is expected to return its own `{ok:false, reason:'timeout'}` well
      // before this fires) — a small margin, not a second budget.
      timeoutMs: timeoutMs + SOLVER_SAFETY_MARGIN_MS,
      signal: req.signal,
    })
    return toSolverOutput(spawned)
  } catch (err) {
    log('human_solve.spawn_error', { host: req.host, mode, error: String(err) })
    return { ok: false, reason: 'error' }
  }
}

const acquireClearedSlot: HumanSolverPorts['acquireClearedSlot'] = () => clearedSlots.acquire()
const releaseClearedSlot: HumanSolverPorts['releaseClearedSlot'] = () => clearedSlots.release()

export const humanSolver: HumanSolve | undefined = env.HUMAN_SOLVE_SSH_HOST
  ? createHumanSolver({
      waitMs: env.HUMAN_SOLVE_WAIT_MS,
      now: Date.now,
      log,
      state: createHumanSolveState(),
      promptUser,
      runSolver,
      acquireClearedSlot,
      releaseClearedSlot,
    })
  : undefined
