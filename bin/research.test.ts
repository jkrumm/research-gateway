import { describe, it, expect } from 'bun:test'
import {
  batchKey,
  exitCodeFor,
  finishedLine,
  liveStatusLine,
  parseBatchFile,
  parseArgs,
  reportSummaryLines,
  resolveContextText,
  resolveToken,
  run,
  submitRequestBody,
  type CliContext,
  type CliIo,
  type FetchLike,
  type SubmitCommand,
} from './research.js'
import type { ResearchReport } from '../src/agent/schema.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────────

function report(overrides: Partial<ResearchReport> = {}): ResearchReport {
  return {
    report: 'The answer is 42.',
    citations: [],
    sources: [],
    unverified: [],
    status: 'ok',
    warnings: [],
    grounding: {
      pagesRetrieved: 0,
      pagesMissing: 0,
      pagesFailed: 0,
      citationsKept: 0,
      citationsDropped: 0,
      confidenceCapped: 0,
      citationsDegraded: 0,
      citationsNumberUnmatched: 0,
    },
    cost: {
      wallMs: 1_000,
      totalUsd: 0.01,
      llmUsd: 0.005,
      searchUsd: 0.005,
      searchCalls: 1,
      tavilyCredits: 0,
      tavilyExtractCalls: 0,
    },
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function parseSubmit(argv: string[]): SubmitCommand {
  const { command } = parseArgs(argv)
  if (command.kind !== 'submit') throw new Error('expected a submit command')
  return command
}

function makeIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err }
}

function makeCtx(overrides: Partial<CliContext> = {}): CliContext {
  return {
    fetchFn: async () => jsonResponse({}),
    env: {},
    resolveToken: () => 'test-token',
    sleepFn: async () => {},
    ...overrides,
  }
}

// ── Argument parsing (pure) ──────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses a bare query as a submit', () => {
    const command = parseSubmit(['what is bun'])
    expect(command.query).toBe('what is bun')
    expect(command.depth).toBeUndefined()
    expect(command.context).toBeUndefined()
    expect(command.idempotencyKey).toBeUndefined()
  })

  it('parses --depth and --key in both `--flag value` and `--flag=value` forms', () => {
    const spaced = parseSubmit(['q', '--depth', 'deep', '--key', 'abc'])
    expect(spaced.depth).toBe('deep')
    expect(spaced.idempotencyKey).toBe('abc')

    const inline = parseSubmit(['q', '--depth=quick', '--key=xyz'])
    expect(inline.depth).toBe('quick')
    expect(inline.idempotencyKey).toBe('xyz')
  })

  it('distinguishes --context text from --context @file', () => {
    expect(parseSubmit(['q', '--context', 'Bun 1.2 is current']).context).toEqual({
      kind: 'text',
      text: 'Bun 1.2 is current',
    })
    expect(parseSubmit(['q', '--context', '@notes.md']).context).toEqual({
      kind: 'file',
      path: 'notes.md',
    })
  })

  it('parses the wait and status subcommands', () => {
    expect(parseArgs(['wait', 'job-1']).command).toEqual({ kind: 'wait', jobId: 'job-1' })
    expect(parseArgs(['status', 'job-2']).command).toEqual({ kind: 'status', jobId: 'job-2' })
    expect(parseArgs(['cancel', 'job-3']).command).toEqual({ kind: 'cancel', jobId: 'job-3' })
  })

  it('sets --json and --no-wait on the options', () => {
    const { options } = parseArgs(['q', '--json', '--no-wait'])
    expect(options).toEqual({ json: true, noWait: true })
  })

  it('--help short-circuits to the help command', () => {
    expect(parseArgs(['--help']).command).toEqual({ kind: 'help' })
  })

  it('rejects an unknown flag, a bad depth, a key out of range, and a missing query', () => {
    expect(() => parseArgs(['q', '--bogus'])).toThrow()
    expect(() => parseArgs(['q', '--depth', 'huge'])).toThrow()
    expect(() => parseArgs(['q', '--key', ''])).toThrow()
    expect(() => parseArgs(['q', '--key', 'x'.repeat(201)])).toThrow()
    expect(() => parseArgs([])).toThrow()
    expect(() => parseArgs(['wait'])).toThrow()
  })
})

describe('submitRequestBody', () => {
  it('carries query, the idempotency key, and only the fields that are set', () => {
    const command = parseSubmit(['q', '--depth', 'standard'])
    expect(submitRequestBody(command, { idempotencyKey: 'k1' })).toEqual({
      query: 'q',
      depth: 'standard',
      idempotencyKey: 'k1',
    })
    expect(submitRequestBody(command, { context: 'given', idempotencyKey: 'k2' })).toEqual({
      query: 'q',
      depth: 'standard',
      context: 'given',
      idempotencyKey: 'k2',
    })
  })
})

describe('resolveContextText', () => {
  it('passes text through and reads a file via the injected reader', () => {
    expect(resolveContextText(undefined, () => 'never')).toBeUndefined()
    expect(resolveContextText({ kind: 'text', text: 'hi' }, () => 'never')).toBe('hi')
    expect(resolveContextText({ kind: 'file', path: 'a.md' }, () => 'file body')).toBe('file body')
  })

  it('turns a read failure into a usage error', () => {
    expect(() =>
      resolveContextText({ kind: 'file', path: 'a.md' }, () => {
        throw new Error('ENOENT')
      }),
    ).toThrow(/could not read --context file a\.md/)
  })
})

describe('exitCodeFor', () => {
  it('maps done to 0 and any error-ish status to 1', () => {
    expect(exitCodeFor('done')).toBe(0)
    expect(exitCodeFor('error')).toBe(1)
    expect(exitCodeFor('running')).toBe(1)
  })
})

describe('resolveToken', () => {
  it('prefers the env token over the keychain', () => {
    expect(resolveToken({ RESEARCH_GATEWAY_TOKEN: 'env-token' }, () => 'keychain')).toBe('env-token')
  })

  it('falls back to the keychain when the env var is unset or blank', () => {
    expect(resolveToken({}, () => 'keychain')).toBe('keychain')
    expect(resolveToken({ RESEARCH_GATEWAY_TOKEN: '   ' }, () => 'keychain')).toBe('keychain')
  })
})

describe('reportSummaryLines', () => {
  it('surfaces status, warnings, and every unverified topic', () => {
    const lines = reportSummaryLines(
      report({
        status: 'partial',
        warnings: ['evidence was lost'],
        unverified: [{ topic: 'Module:Items', url: null, reason: 'never retrieved' }],
      }),
    )
    expect(lines[0]).toBe('status: partial | warnings: 1 | unverified: 1')
    expect(lines.some((l) => l.includes('warning: evidence was lost'))).toBe(true)
    expect(lines.some((l) => l.includes('unverified: Module:Items'))).toBe(true)
  })
})

// ── run() against an injected fetch ──────────────────────────────────────────────

describe('run — auth', () => {
  it('exits 2 with a clear message when no token is available', async () => {
    const { io, err } = makeIo()
    const code = await run(['q'], makeCtx({ resolveToken: () => null }), io)
    expect(code).toBe(2)
    expect(err.join('')).toContain('no bearer token')
  })
})

describe('run — submit', () => {
  it('sends an auto-generated idempotency key and prints the jobId with --no-wait', async () => {
    let sentBody: Record<string, unknown> | null = null
    const fetchFn: FetchLike = async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({ jobId: 'job-1', status: 'queued' })
    }
    const { io, out } = makeIo()
    const code = await run(['what is bun', '--no-wait'], makeCtx({ fetchFn }), io)
    expect(code).toBe(0)
    expect(out.join('')).toBe('job-1\n')
    expect(sentBody).not.toBeNull()
    const body = sentBody as unknown as Record<string, unknown>
    expect(typeof body['idempotencyKey']).toBe('string')
    expect((body['idempotencyKey'] as string).length).toBeGreaterThan(0)
  })

  it('maps an admission refusal (429) to exit 2 and prints the Retry-After', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ error: 'Research queue is full, retry shortly' }, 429, { 'retry-after': '30' })
    const { io, err } = makeIo()
    const code = await run(['q'], makeCtx({ fetchFn }), io)
    expect(code).toBe(2)
    expect(err.join('')).toContain('Research queue is full')
    expect(err.join('')).toContain('retry after 30s')
  })

  it('exits 3 when the server stays unreachable through the retries', async () => {
    const fetchFn: FetchLike = async () => {
      throw new TypeError('fetch failed')
    }
    const { io, err } = makeIo()
    const code = await run(['q'], makeCtx({ fetchFn }), io)
    expect(code).toBe(3)
    expect(err.join('')).toContain('unreachable')
  })
})

describe('run — wait', () => {
  it('polls a running job to done, prints the report to stdout and status to stderr', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls++
      if (calls === 1) return jsonResponse({ status: 'running', result: null, error: null })
      return jsonResponse({
        status: 'done',
        error: null,
        result: report({ report: 'Final answer.' }),
      })
    }
    const { io, out, err } = makeIo()
    const code = await run(['wait', 'job-9'], makeCtx({ fetchFn }), io)
    expect(code).toBe(0)
    expect(out.join('')).toBe('Final answer.\n')
    expect(err.join('')).toContain('status: ok')
  })

  it('recovers from a transient poll failure before the job finishes', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed')
      return jsonResponse({ status: 'done', error: null, result: report() })
    }
    const { io, err } = makeIo()
    const code = await run(['wait', 'job-10'], makeCtx({ fetchFn }), io)
    expect(code).toBe(0)
    expect(err.join('')).toContain('poll recovered')
  })

  it('exits 1 on a terminal job error and reports it', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ status: 'error', result: null, error: 'upstream 403' })
    const { io, err } = makeIo()
    const code = await run(['wait', 'job-11'], makeCtx({ fetchFn }), io)
    expect(code).toBe(1)
    expect(err.join('')).toContain('upstream 403')
  })
})

describe('run — status', () => {
  it('prints the full job JSON with --json and returns the terminal exit code', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ status: 'error', result: null, error: 'boom' })
    const { io, out } = makeIo()
    const code = await run(['status', 'job-12', '--json'], makeCtx({ fetchFn }), io)
    expect(code).toBe(1)
    expect(JSON.parse(out.join(''))).toEqual({ jobId: 'job-12', status: 'error', result: null, error: 'boom' })
  })

  it('returns 0 for a non-terminal job', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ status: 'queued', result: null, error: null })
    const { io } = makeIo()
    expect(await run(['status', 'job-13'], makeCtx({ fetchFn }), io)).toBe(0)
  })

  it('exits 1 when the job id is unknown (404)', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ error: 'not found' }, 404)
    const { io, err } = makeIo()
    const code = await run(['status', 'nope'], makeCtx({ fetchFn }), io)
    expect(code).toBe(1)
    expect(err.join('')).toContain('job not found')
  })
})

describe('run — cancel', () => {
  it('sends DELETE for the job and prints its new status', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = []
    const fetchFn: FetchLike = async (input, init) => {
      calls.push({ url: String(input), method: init?.method })
      return jsonResponse({ jobId: 'job-20', status: 'cancelled' })
    }
    const { io, out } = makeIo()
    const code = await run(['cancel', 'job-20'], makeCtx({ fetchFn }), io)
    expect(code).toBe(0)
    expect(calls).toEqual([{ url: 'http://127.0.0.1:7780/research/job-20', method: 'DELETE' }])
    expect(out.join('')).toBe('job-20 cancelled\n')
  })

  it('exits 1 when the job id is unknown (404)', async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ error: 'not found' }, 404)
    const { io, err } = makeIo()
    expect(await run(['cancel', 'nope'], makeCtx({ fetchFn }), io)).toBe(1)
    expect(err.join('')).toContain('job not found')
  })

  it('a wait that lands on a cancelled job ends with exit 1', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ status: 'cancelled', result: null, error: 'Cancelled by the caller before it finished.' })
    const { io, err } = makeIo()
    expect(await run(['wait', 'job-21'], makeCtx({ fetchFn }), io)).toBe(1)
    expect(err.join('')).toContain('cancelled')
  })
})

describe('liveStatusLine', () => {
  const now = Date.parse('2026-09-25T07:10:00.000Z')

  it('shows queue position and wait time for a queued job', () => {
    const line = liveStatusLine(
      {
        status: 'queued',
        result: null,
        error: null,
        submittedAt: '2026-09-25T07:08:00.000Z',
        startedAt: null,
        queuePosition: 4,
        progress: null,
        typicalDurationMs: { p50: 111_000, p90: 259_000 },
      },
      now,
    )
    expect(line).toBe('status: queued · queue position 4 · waiting 120s')
  })

  it('shows phase, worker counts and run time against the typical range for a running job', () => {
    const line = liveStatusLine(
      {
        status: 'running',
        result: null,
        error: null,
        submittedAt: '2026-09-25T07:00:00.000Z',
        startedAt: '2026-09-25T07:09:15.000Z',
        queuePosition: null,
        progress: { phase: 'researching', round: 2, workers: { done: 5, total: 8 } },
        typicalDurationMs: { p50: 111_000, p90: 259_000 },
      },
      now,
    )
    expect(line).toBe(
      'status: running · researching round 2, workers 5/8 · running 45s (typical p50 111s, p90 259s)',
    )
  })

  it('degrades to the bare status against a server without live fields', () => {
    expect(liveStatusLine({ status: 'running', result: null, error: null }, now)).toBe('status: running')
  })
})

describe('run — submit warnings', () => {
  it('prints a server input warning to stderr with the cancel command', async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ jobId: 'job-30', status: 'queued', warnings: ['`context` is an unexpanded shell variable'] })
    const { io, out, err } = makeIo()
    const code = await run(['q about zod', '--context', '$CTX', '--no-wait'], makeCtx({ fetchFn }), io)
    expect(code).toBe(0)
    expect(out.join('')).toBe('job-30\n')
    expect(err.join('')).toContain('warning: `context` is an unexpanded shell variable (research cancel job-30)')
  })
})

describe('batch and wait-all', () => {
  it('parses batch with shared defaults and wait-all with several ids', () => {
    expect(parseArgs(['batch', 'q.jsonl', '--depth', 'quick', '--context', '@facts.md']).command).toEqual({
      kind: 'batch',
      path: 'q.jsonl',
      depth: 'quick',
      context: { kind: 'file', path: 'facts.md' },
    })
    expect(parseArgs(['wait-all', 'a', 'b', 'c']).command).toEqual({ kind: 'wait-all', jobIds: ['a', 'b', 'c'] })
    expect(() => parseArgs(['batch'])).toThrow()
    expect(() => parseArgs(['batch', 'q.jsonl', '--key', 'k'])).toThrow()
    expect(() => parseArgs(['wait-all'])).toThrow()
  })

  it('parseBatchFile skips blanks and comments, and rejects the whole file on one bad line', () => {
    const text = [
      '# Wild Rift items',
      '{"query": "Frozen Heart 7.3 changes", "key": "fh"}',
      '',
      '{"query": "Sunfire Aegis 7.3 changes", "depth": "quick", "context": "patch 7.3"}',
    ].join('\n')
    expect(parseBatchFile(text)).toEqual([
      { query: 'Frozen Heart 7.3 changes', key: 'fh' },
      { query: 'Sunfire Aegis 7.3 changes', depth: 'quick', context: 'patch 7.3' },
    ])
    expect(() => parseBatchFile('{"query": "ok query"}\nnot json')).toThrow('batch line 2')
    expect(() => parseBatchFile('{"query": "ok query", "depth": "huge"}')).toThrow('depth')
    expect(() => parseBatchFile('{"q": "missing"}')).toThrow('query')
    expect(() => parseBatchFile('# only a comment')).toThrow('no jobs')
  })

  it('batch submits every line with the shared context, reports a refused line, and exits 2', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchFn: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if (body['query'] === 'second question') return jsonResponse({ error: 'Research queue is full' }, 429)
      return jsonResponse({ jobId: `job-${bodies.length}`, status: 'queued' })
    }
    const files: Record<string, string> = {
      'q.jsonl': '{"query": "first question", "key": "k1"}\n{"query": "second question"}\n{"query": "third question", "context": "own"}',
      'facts.md': 'shared facts',
    }
    const { io, out, err } = makeIo()
    const code = await run(
      ['batch', 'q.jsonl', '--context', '@facts.md', '--depth', 'quick', '--json'],
      makeCtx({ fetchFn, readFile: (path) => files[path] ?? '' }),
      io,
    )
    expect(code).toBe(2)
    expect(bodies.map((b) => [b['query'], b['context'], b['depth']])).toEqual([
      ['first question', 'shared facts', 'quick'],
      ['second question', 'shared facts', 'quick'],
      ['third question', 'own', 'quick'],
    ])
    expect(bodies[0]?.['idempotencyKey']).toBe('k1')
    const rows = out.join('').trim().split('\n').map((line) => JSON.parse(line) as { jobId: string; key: string })
    expect(rows.map((r) => r.jobId)).toEqual(['job-1', 'job-3'])
    expect(rows[0]?.key).toBe('k1')
    expect(err.join('')).toContain('not submitted: second question')
  })

  it('wait-all prints each job as it finishes and exits 1 when one did not end done', async () => {
    let polls = 0
    const fetchFn: FetchLike = async (input) => {
      polls++
      const id = String(input).split('/').pop()
      if (id === 'a') return jsonResponse({ status: 'done', result: report(), error: null })
      // b finishes on its second poll, with an error.
      if (polls < 3) return jsonResponse({ status: 'running', result: null, error: null })
      return jsonResponse({ status: 'error', result: null, error: 'boom' })
    }
    const { io, out } = makeIo()
    const code = await run(['wait-all', 'a', 'b'], makeCtx({ fetchFn }), io)
    expect(code).toBe(1)
    expect(out.join('')).toBe('a\tdone\tok\tcitations 0\tunverified 0\nb\terror\tboom\n')
  })

  it('finishedLine names a cancelled job', () => {
    expect(finishedLine('c', { status: 'cancelled', result: null, error: 'x' })).toBe('c\tcancelled')
  })
})

describe('batchKey', () => {
  it('is stable for the same line and changes with query, depth or context', () => {
    const base = { query: 'Frozen Heart 7.3', depth: 'quick' as const, context: 'facts' }
    expect(batchKey(base)).toBe(batchKey({ ...base }))
    expect(batchKey(base)).toMatch(/^batch-[0-9a-f]{32}$/)
    expect(batchKey({ ...base, query: 'Sunfire 7.3' })).not.toBe(batchKey(base))
    expect(batchKey({ ...base, depth: 'deep' })).not.toBe(batchKey(base))
    expect(batchKey({ ...base, context: 'other' })).not.toBe(batchKey(base))
    // An omitted depth is the server default, so it keys the same as an explicit standard.
    expect(batchKey({ query: 'q' })).toBe(batchKey({ query: 'q', depth: 'standard' }))
  })
})
