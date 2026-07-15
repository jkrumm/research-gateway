// Throwaway local smoke harness for the agent loop — NOT part of the service.
// Runs one runResearch() end-to-end against the real IU endpoint + Tavily, prints a
// compact trace. Does NOT import index.ts, so no HTTP server is started.
//
// Run (from repo root), Tavily key from the macOS keychain + IU from 1Password:
//   TAVILY_API_KEY="$(security find-generic-password -s tavily-api-key -w)" \
//   secrets-run run --env-file=/tmp/rg-smoke.env -- bun run scripts/smoke.ts "<query>" <depth>
//
// /tmp/rg-smoke.env must define API_SECRET (any dummy), IU_BASE_URL, IU_API_KEY, IU_MODEL.

import { runResearch } from '../src/agent/run.js'
import type { Depth } from '../src/agent/schema.js'

const query =
  process.argv[2] ??
  'What is the current stable version of the Elysia web framework, and how do you register the @elysiajs/openapi plugin?'
const depth = (process.argv[3] as Depth | undefined) ?? 'quick'

console.log(`[smoke] query=${JSON.stringify(query)} depth=${depth}`)
const t0 = Date.now()
let usage: unknown = null

try {
  const report = await runResearch({ query, depth, jobId: 'smoke' }, (u) => {
    usage = u
  })
  const ms = Date.now() - t0

  console.log('\n[smoke] ===== REPORT =====')
  console.log((report.report ?? '').slice(0, 2500))
  console.log('\n[smoke] ===== META =====')
  console.log('citations:', report.citations.length)
  console.log('sources:', report.sources)
  console.log('usage:', usage)
  console.log('wallClockMs:', ms)
  console.log('[smoke] OK')
} catch (err) {
  console.error('\n[smoke] FAILED after', Date.now() - t0, 'ms')
  console.error(err)
  process.exit(1)
}
