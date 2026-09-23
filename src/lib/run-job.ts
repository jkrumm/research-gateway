// Thin, env-wired instance of job-runner-core.ts's `createJobRunner` — same public API
// (`startResearchJob`, `startAdoptionLoop`), same behaviour, just constructed against the real
// job store, the real `runResearch` (agent/run.js, LLM-backed), the real `reportUsage`, and
// `env.*` for the model ids. All the actual lease/adoption/crash-loop logic lives in
// job-runner-core.ts, which is unit-tested directly (job-store.test.ts) with an injected FAKE
// `runResearch` — no LLM, no env — against the real `job-store-core.ts` state machine.
import { jobStoreInstance } from './job-store.js'
import { runResearch } from '../agent/run.js'
import { reportUsage } from './usage.js'
import { env } from '../env.js'
import { log } from './log.js'
import { createJobRunner, type JobRunner } from './job-runner-core.js'

const runner: JobRunner = createJobRunner({
  store: jobStoreInstance,
  runResearch,
  reportUsage,
  log,
  leadModel: env.IU_LEAD_MODEL,
  workerModel: env.IU_WORKER_MODEL,
})

export const startResearchJob = runner.startResearchJob

/** Called once from index.ts at boot; runs itself again every 30s after. */
export function startAdoptionLoop(): void {
  runner.startAdoptionLoop()
}
