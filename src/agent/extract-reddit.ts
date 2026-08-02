// Reddit-specific extraction, used instead of Readability for threads reached through the
// old.reddit.com rewrite (see fetch-url.ts).
//
// Why this exists: Readability treats a Reddit thread as an ARTICLE and keeps the submission
// while discarding the comment tree — which is the entire reason the thread is worth reading.
// Measured 2026-08-02 on old.reddit.com HTML:
//
//   thread                Readability   comment tree
//   1814 comments              2,729         37,963   (14x)
//   43 comments                2,957         16,080   (5.4x)
//
// Both fit well inside TEXT_CAP (80k), so the extra text is real evidence reaching the
// worker, not padding that gets truncated. Practitioner reports are exactly the long-tail
// material the Sonar migration exists to reach, and Reddit is where they live.
//
// Comment scores are kept because they are the one endorsement signal the page carries: a
// claim at +240 and a claim at -3 are not equally worth citing, and the worker has no other
// way to tell them apart once the text is flattened.
//
// Takes an already-parsed Document so this module needs no fetch, no env and no linkedom
// import of its own — testable in isolation, same convention as ledger/extract/cost.

// Minimal structural view of the DOM this needs. Avoids depending on lib.dom or linkedom's
// exported types, both of which drag in more than this file uses.
interface MinimalElement {
  textContent: string | null
  querySelector(selectors: string): MinimalElement | null
  querySelectorAll(selectors: string): ArrayLike<MinimalElement>
}
export interface MinimalDocument {
  querySelector(selectors: string): MinimalElement | null
  querySelectorAll(selectors: string): ArrayLike<MinimalElement>
}

function text(node: MinimalElement | null): string {
  return (node?.textContent ?? '').trim()
}

// old.reddit renders the submission and every comment with the same `.usertext-body .md`
// wrapper, so the submission is simply the first one when the thread is a self-post. Link
// posts have no submission body at all, which is why an empty result here is not an error.
const BODY_SELECTOR = '.usertext-body .md'

/**
 * Flattens an old.reddit thread into `title` + scored comment bodies.
 *
 * Returns null when the document does not look like an old.reddit thread, so the caller can
 * fall back to Readability rather than emit an empty page — a silently empty extraction is
 * the failure mode that made Reddit worth fixing in the first place.
 */
export function extractRedditThread(document: MinimalDocument): string | null {
  const bodies = Array.from(document.querySelectorAll(BODY_SELECTOR))
  if (bodies.length === 0) return null

  const title = text(document.querySelector('a.title')) || text(document.querySelector('title'))

  // Scores are read from the comment containers rather than paired positionally with the
  // bodies: old.reddit emits hidden duplicate score spans (`.score.dislikes/.unvoted/.likes`)
  // and deleted comments keep a container but lose their body, so index-matching the two
  // lists drifts. Reading the score from each `.entry`'s own subtree keeps them together.
  const comments: string[] = []
  for (const entry of Array.from(document.querySelectorAll('.entry'))) {
    const body = text(entry.querySelector(BODY_SELECTOR))
    if (!body) continue
    const score = text(entry.querySelector('.score.unvoted'))
    comments.push(score ? `[${score}] ${body}` : body)
  }

  // Fall back to the flat body list if the `.entry` structure was not what we expected —
  // fewer signals, but never fewer comments than Readability would have kept.
  const parts = comments.length > 0 ? comments : Array.from(bodies).map((b) => text(b)).filter(Boolean)
  if (parts.length === 0) return null

  return [title, ...parts].filter(Boolean).join('\n\n')
}
