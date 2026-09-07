// Throwaway local smoke harness for the agent loop — NOT part of the service.
// Runs one runResearch() end-to-end against the real IU endpoint + Tavily, prints a
// compact trace. Does NOT import index.ts, so no HTTP server is started.
//
// Run (from repo root) with the same secrets template `bun run dev` uses:
//   secrets-run run --env-file=.env.local.tpl -- bun run scripts/smoke.ts "<query>" <depth>
//
// That template points ARGO_USAGE_URL at prod argo, so a smoke run reports usage there under
// jobId `smoke`. Add `--env-file=<file>` with `ARGO_API_SECRET=` (empty) after it to keep the
// run out of the dashboard — the last file wins, and an empty secret disables reporting.

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
