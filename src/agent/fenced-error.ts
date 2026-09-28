// Thrown by `rounds.ts`'s `runRounds` (and by `run.ts` itself, once more before synthesis) when
// a checkpoint-boundary check finds this process no longer owns the job's lease — another
// replica already claimed it (`job-store.ts`'s `claimStaleJobs`) and is resuming from the
// checkpoint THIS process itself last wrote. Routed by `run-job.ts` exactly like
// `HandedOffError`: logged, never `markFailed`, and the checkpoint is left alone rather than
// cleared, since the adopter still needs it.
//
// Its own tiny module (not job-store.ts, not rounds.ts) so both of those can import it without
// creating a cycle, and so it stays trivially importable from run.ts's env-chained module too.
export class FencedError extends Error {}
