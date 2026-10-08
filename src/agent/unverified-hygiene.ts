import type { UnverifiedEntry } from './schema.js'

// `unverified` is the caller's list of what could not be checked. Two kinds of entry pad it
// without telling the caller anything (up to 91 per job in the 2026-10-08 audit):
//   - a guessed URL that answered 404/410 — the worker constructed an address that does not
//     exist; nothing was lost, the page is not there;
//   - worker housekeeping, "page-text budget exhausted" — a statement about the run, not a
//     topic that stayed open.
// Both are dropped unless the report prose names their URL (`inProse`; url-less housekeeping
// is always dropped) or the entry records a dropped citation (`protectedUrls`) — then it is
// evidence the caller must see.
//
// Pure and env-free so it is testable without the ledger: the caller supplies the two facts it
// owns (is the URL a ledger `missing`, does the prose mention it).

const HOUSEKEEPING = /page-text budget|budget (?:is |was |has )?(?:spent|exhausted|ran out)|search budget exhausted/i
const NOT_FOUND = /\bHTTP (?:404|410)\b|does not exist at this URL/i

export type HygieneContext = {
  /** The origin answered 404/410 for this URL (ledger tier `missing`). */
  isMissing: (url: string) => boolean
  /** The report prose names this entry's source. */
  inProse: (entry: UnverifiedEntry) => boolean
  /** URLs of entries that restate a dropped citation — never tidied away. */
  protectedUrls: ReadonlySet<string>
}

function isNoise(entry: UnverifiedEntry, ctx: HygieneContext): boolean {
  if (entry.url && ctx.protectedUrls.has(entry.url)) return false
  if (HOUSEKEEPING.test(entry.reason) || HOUSEKEEPING.test(entry.topic)) return true
  if (!entry.url) return false
  return ctx.isMissing(entry.url) || NOT_FOUND.test(entry.reason)
}

/** Drop noise entries nothing depends on, then group the rest by topic (stable within a topic). */
export function tidyUnverified(entries: ReadonlyArray<UnverifiedEntry>, ctx: HygieneContext): UnverifiedEntry[] {
  const kept = entries.filter((entry) => !isNoise(entry, ctx) || ctx.inProse(entry))
  const order = new Map<string, number>()
  for (const entry of kept) {
    const key = entry.topic.trim().toLowerCase()
    if (!order.has(key)) order.set(key, order.size)
  }
  return kept
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        (order.get(a.entry.topic.trim().toLowerCase()) ?? 0) - (order.get(b.entry.topic.trim().toLowerCase()) ?? 0) ||
        a.index - b.index,
    )
    .map(({ entry }) => entry)
}
