import { domainToUnicode } from 'node:url'
import { normalizeUrl, urlParts } from './ledger.js'
import type { UnverifiedEntry } from './schema.js'

// Issue #7: the citation gate does not reach the report PROSE. A synthesizer can still name
// a blocked source in the body — a raw URL, a markdown link target, or a bare host — while
// listing it under `unverified`, and the structured gate has no say over that text. The
// 2026-08-06 Nunu/Blitz.gg run shipped exactly this shape (docs/field-notes.md). Prompt-only
// citation rules failed twice before the ledger existed; the body gets the same treatment as
// the citation list: enforced in code.
//
// A pure module, and dependency-free beyond ledger's URL helpers, for the same reason
// `ledger`/`extract`/`assemble` are: this is the part worth unit-testing without booting the
// env/LLM import chain, and it keeps ground.ts about comparing structured claims against
// ledger tiers.
//
// Annotates rather than deletes: removing sentences would silently drop claims the caller
// paid for, so each disowned reference gets the run's own reason for distrusting it.
//
// WHY THIS SEARCHES FOR THE SOURCE RATHER THAN TOKENIZING THE BODY. The natural first design
// is to pull URL-ish tokens out of the prose and compare each to the blocked URL. That shape
// was tried and abandoned: every boundary decision then has to be made blind, before knowing
// what it is being compared against, and prose glues arbitrary syntax onto a URL — markdown
// emphasis, footnotes, parentheticals, sentence punctuation. Each fix for one shape broke or
// missed another, and the failures were silent in both directions (a real mention unflagged,
// or unrelated text annotated).
//
// Inverting it removes the guessing. For each blocked URL there is exactly ONE string to
// find, so the boundary question becomes answerable: a character terminates the match only
// if continuing past it could still be this same URL. Everything else is a separator. The
// body is never tokenized, so no token can be mis-assembled in the first place.

// schema.ts owns this shape; importing it directly (no local alias) means a schema change
// cannot leave a stale copy behind, and there is no second name for the same type.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A case-insensitive character class for one literal string, so a single pattern can match a
// host case-insensitively while leaving the path case-sensitive — the two need different
// rules (DNS ignores case, HTTP paths do not) and one `i` flag cannot express both (it would
// apply to the path too).
//
// The fold is Unicode-aware, not ASCII-only: a host like `münchen.de` must match a body's
// `MÜNCHEN.DE`, and folding only `[a-zA-Z]` would silently miss it — a false negative on a
// real mention, the failure this module exists to prevent. A character whose case mapping is
// not one-to-one (e.g. `ß`) is left literal rather than mis-folded.
//
// Escaping goes through `escape()` rather than a second copy of the metacharacter set: two
// copies of that set are exactly the drift this module warns about elsewhere.
function ciClass(literal: string): string {
  return [...literal]
    .map((c) => {
      const lower = c.toLowerCase()
      const upper = c.toUpperCase()
      if (lower === upper) return escape(c)
      if (lower.length !== 1 || upper.length !== 1) return escape(c)
      return `[${escape(lower)}${escape(upper)}]`
    })
    .join('')
}

// What may not IMMEDIATELY PRECEDE a match: a character that would make it the tail of a
// longer host or path. `notnunu.gg` and `sub.nunu.gg` must not match `nunu.gg`; a combining
// mark must count as part of the hostname, or a decomposed `münchen.de` yields `nchen.de`.
const LEFT = `(?<![\\p{L}\\p{N}\\p{M}\\-./@])`

// What may not IMMEDIATELY FOLLOW a match — the character that would mean the URL continues:
//   - a letter/number/mark extends the host or a path segment (`nunu.ggx`, `patch-notes2`)
//   - `-` extends a path segment (`patch-notes-archive` is not `patch-notes`)
//   - `/` `?` `#` start a further path/query/fragment (`nunu.gg/other-page`, `nunu.gg?ref=x`)
//   - `%` `&` `=` `+` `$` continue a path or query
//   - `@` makes it an email address (`nunu.gg@example.com`)
//   - `:` only when a port follows (`nunu.gg:8443`) — a colon is otherwise prose punctuation
//   - `.` only when a word OR digit follows (`patch-notes.html`, `patch-notes.2026`), so a
//     sentence-final period matches but a longer filename does not
// `?` and `#` are here because a query or fragment makes it a DIFFERENT document — the same
// call `normalizeUrl` makes for citations, where `?v=2` is deliberately not the same page.
// Deliberately NOT excluded: `,` `;` `!` `*` `_` `~` `(` `[` and quotes. Prose and markdown
// glue those straight onto a URL (`nunu.gg/x,and`, `**nunu.gg/x**`, `nunu.gg/x[1]`,
// `nunu.gg/x(archived)`), and treating them as continuations loses real mentions.
const RIGHT = `(?![\\p{L}\\p{N}\\p{M}\\-/%&=+$@?#])(?!:\\d)(?!\\.(?:\\p{L}|\\d))`

// The bounded forms of one blocked URL as it may appear in prose: the exact URL, scheme-less,
// `www.`-less, and as a bare host. `normalizeUrl` supplies the canonical host+path+query, so
// host case, `www.`, the scheme and a trailing slash are one rule rather than a second,
// hand-tuned one that can drift from the citation gate's.
//
// The path is OPTIONAL so a bare host still counts: a body that says `per nunu.gg` names the
// source. The RIGHT boundary is what keeps that from over-reaching — `nunu.gg/other-page`
// fails on the `o` after the slash, so a bare host matches the host alone and never a
// different page.
//
// A query string is part of the canonical form, so a body mention carrying `?ref=abc` does
// NOT match a blocked URL without one — a different document, the same call `normalizeUrl`
// already makes for citations.
//
// FRAGMENTS ARE THE ONE PLACE THIS DELIBERATELY DIVERGES from `normalizeUrl`, which drops
// them (a fragment identifies a section of the same page, so citations should match across
// it). Here the two directions are not symmetrical: a body naming `page#section` IS naming
// the blocked `page#section`, so dropping the fragment from the pattern would silently miss
// it; and a body naming the fragmentless `page` must NOT be annotated for a blocked
// `page#section`. Keeping the fragment in the pattern satisfies both — the verbatim mention
// matches, and the fragmentless one fails the RIGHT boundary at `#`.
function patternFor(url: string): RegExp | null {
  const parts = urlParts(url)
  if (!parts) return null
  const { host, rest, hash } = parts
  // A Unicode host is IDNA-encoded to punycode by `new URL()` (`münchen.de` ->
  // `xn--mnchen-3ya.de`), but the report body and the caller's own `unverified` entry both
  // carry the Unicode form. Accepting either spelling is the difference between flagging a
  // real mention and silently missing it, so the host alternation carries both.
  const unicodeHost = domainToUnicode(host)
  const hostPattern = unicodeHost === host ? ciClass(host) : `(?:${ciClass(host)}|${ciClass(unicodeHost)})`
  // The `u` flag is load-bearing: without it `\p{L}` is an identity escape for a literal `p`,
  // so the boundary classes silently degrade to `[p{L}N...]` and stop excluding letters —
  // which is how `notnunu.gg` and `münchen.de` got flagged as `nunu.gg` and `nchen.de`.
  // The trailing `/?` is what lets a body's `nunu.gg/` match a blocked `nunu.gg` (and vice
  // versa): the canonical form strips a trailing slash, so it is not part of `rest`, but prose
  // writes it. It cannot over-reach to `nunu.gg/other-page` — with the slash consumed, RIGHT
  // sees the `o` of `other-page` and rejects the match.
  const body = `${LEFT}(?:https?://)?(?:${ciClass('www.')})?${hostPattern}(?:${escape(rest)})?/?${escape(hash)}?${RIGHT}`
  return new RegExp(body, 'u')
}

// Whether the body names this source.
function referencesBody(body: string, url: string): boolean {
  const pattern = patternFor(url)
  return pattern !== null && pattern.test(body)
}

// Prepend one blockquote note per distinct disowned source the body names, carrying the
// run's own reason. Returns the annotated body plus how many sources were flagged — the
// caller feeds that count into `degraded`/`status`, because a body naming an unverifiable
// source is evidence lost exactly like a dropped citation, and leaving it out of the status
// would close issue #7 only halfway.
//
// Dedup keys on the CANONICAL url, not the raw string: two entries for the same page in
// different string forms (trailing slash, scheme, `www.`) are one page, and each would
// otherwise emit a duplicate note.
export function scrubBody(
  body: string,
  unverified: ReadonlyArray<UnverifiedEntry>,
): { body: string; annotated: number } {
  let notes = ''
  let annotated = 0
  const seen = new Set<string>()
  for (const entry of unverified) {
    if (!entry.url) continue
    const key = normalizeUrl(entry.url)
    if (seen.has(key)) continue
    seen.add(key)
    if (!referencesBody(body, entry.url)) continue
    annotated++
    notes += `> **Unverified in prose:** this report references ${entry.url}, which this run could NOT verify (${entry.reason}). Treat that reference as unconfirmed — see \`unverified\`.\n\n`
  }
  return { body: notes + body, annotated }
}
