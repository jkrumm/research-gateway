import { z } from 'zod'
import { SubQuestion, WorkerDigest } from './schema.js'

// Enough of `runResearch`'s (run.ts) loop state to resume a job from its last completed round
// instead of re-planning and re-researching from scratch — the piece "status-only durability"
// (job-db.ts/job-store.ts, pre-lease) never had. Dependency-free by design (schema.js and zod
// only, no env.js import chain) so it stays unit-testable the way `ledger.ts`/`extract.ts` are
// — same convention the file map in AGENTS.md documents.
//
// `job-db.ts` stores this as an opaque `checkpoint_json` string; only this module parses or
// produces its shape. A version mismatch or malformed JSON returns null rather than throwing,
// so an adopting process (job-store.ts's adoption loop) degrades to running the job from
// scratch instead of crashing on a checkpoint it cannot trust — the same "never let a resume
// feature take down a job that would otherwise have just worked" posture `fetch-chain.ts`
// applies to every fallback in its own chain.

export const CHECKPOINT_VERSION = 1

// Mirrors `LedgerSnapshot` (ledger.ts) — that file has no zod schema of its own (it is a
// plain TS interface), so this is the one place its shape is validated rather than trusted.
const LedgerSnapshotSchema = z.object({
  retrieved: z.array(z.string()),
  missing: z.array(z.object({ url: z.string(), reason: z.string() })),
  snippet: z.array(z.string()),
  failed: z.array(z.object({ url: z.string(), reason: z.string() })),
})

// Mirrors `UsageStats` (lib/usage.ts) — imported there only as a type (erased by
// `verbatimModuleSyntax`), so this schema is what actually validates a resumed job's carried
// LLM spend. Per-job SEARCH spend (tools.ts's in-memory meters) is NOT part of this: it
// resets on every process boot, so a resumed job's reported search cost covers only the
// post-restart portion. LLM usage below is unaffected and correct across a resume.
const UsageStatsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  reasoningTokens: z.number(),
  cachedInputTokens: z.number(),
  durationMs: z.number(),
})

const ResearchCheckpointSchema = z.object({
  version: z.literal(CHECKPOINT_VERSION),
  /** The sub-questions of the NEXT round to run — empty once every round has completed. */
  subQuestions: z.array(SubQuestion),
  /** The round number `subQuestions` belongs to. */
  round: z.number().int().min(1),
  digests: z.array(WorkerDigest),
  ledgers: z.array(LedgerSnapshotSchema),
  askedLower: z.array(z.string()),
  failures: z.array(z.string()),
  alreadyRetried: z.boolean(),
  leadUsage: UsageStatsSchema,
  workerUsage: UsageStatsSchema,
  workersDispatchedTotal: z.number().int().min(0),
})

export type ResearchCheckpoint = z.infer<typeof ResearchCheckpointSchema>

export function serializeCheckpoint(checkpoint: ResearchCheckpoint): string {
  return JSON.stringify(checkpoint)
}

/**
 * Parses a stored checkpoint, or returns null when it cannot be trusted: malformed JSON, or a
 * shape/version this build does not recognise. A version bump is a deliberate, one-line
 * escape hatch for changing the shape later without writing a migration — old checkpoints
 * just stop resuming and the job restarts from scratch, which is always correct, only slower.
 */
export function parseCheckpoint(json: string | null | undefined): ResearchCheckpoint | null {
  if (!json) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  const result = ResearchCheckpointSchema.safeParse(raw)
  return result.success ? result.data : null
}
