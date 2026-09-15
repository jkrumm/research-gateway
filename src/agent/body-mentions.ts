import { hostOnly, normalizeUrl } from './ledger.js'

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

export interface UnverifiedMention {
  topic: string
  url: string | null
  reason: string
}

// A URL-ish token in prose: a scheme-ful URL (raw or a markdown link target) or a
// scheme-less host[:port][/path][?query][#fragment] form ("nunu.gg/patch-notes", "per
// nunu.gg").
//
// The lookbehind and lookahead are the whole point — without them the tokenizer reads a
// hostname out of unrelated text and the report is annotated for something it never said:
//   - `nunu.gg@example.com` is an email; the lookahead rejects a token followed by `@`.
//   - `sub.nunu.gg` must not yield a bare `nunu.gg`; the lookbehind rejects a token that
//     starts mid-host.
//   - the port is consumed as part of the token, so `nunu.gg:8443/x` cannot decay into a
//     bare-host mention of `nunu.gg`.
// `)` is allowed inside a token and trimmed by balance in `trimToken`, so a Wikipedia-style
// path keeps its parens while a markdown wrapper loses its own.
const URL_TOKEN =
  /(?<![\w@/.-])(?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:[/?#][^\s\]<>"'`]*)?(?![@\w-])(?!\.\w)/gi

// Punctuation a sentence or a markdown wrapper leaves glued to a token.
function trimToken(token: string): string {
  let s = token.replace(/[\]}>"'`,;:.]+$/, '')
  const count = (c: string) => s.split(c).length - 1
  while (s.endsWith(')') && count(')') > count('(')) s = s.slice(0, -1)
  return s
}

// The canonical form of a token. A scheme is added when the token has none, because
// `normalizeUrl`'s parse-failure fallback lowercases the WHOLE string — which would make a
// scheme-less token's PATH case-insensitive, contradicting the scheme-ful path's behaviour
// and HTTP itself. With a scheme, one rule covers host case, `www.`, the scheme and a
// trailing slash, and path case survives.
function canonical(raw: string): string {
  const t = raw.trim()
  return normalizeUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`)
}

// Whether the body names this source. Comparison goes through `normalizeUrl` — the same
// canonical form the citation gate uses — so host case, `www.`, scheme and a trailing slash
// are one rule rather than a second, hand-tuned one that can drift.
//
// A query string in the body does NOT match a blocked URL without one: `?ref=abc` is a
// different document, the same call `normalizeUrl` already makes for citations.
function referencesBody(body: string, url: string): boolean {
  const target = canonical(url)
  const targetHost = hostOnly(url)
  for (const raw of body.match(URL_TOKEN) ?? []) {
    const token = trimToken(raw)
    if (!token) continue
    if (canonical(token) === target) return true
    // A bare-host mention ("per nunu.gg the …") names the source without a path — but only
    // when the token carries no path of its own. `nunu.gg/other-page` is a different
    // document and must not be read as a mention of `nunu.gg/patch-notes`.
    if (!targetHost) continue
    if (/[/?#]/.test(token.replace(/^https?:\/\//i, ''))) continue
    if (hostOnly(token) === targetHost) return true
  }
  return false
}

// Prepend one blockquote note per distinct disowned source the body names, carrying the
// run's own reason. Returns the annotated body plus how many sources were flagged — the
// caller feeds that count into `degraded`/`status`, because a body naming an unverifiable
// source is evidence lost exactly like a dropped citation, and leaving it out of the status
// would close issue #7 only halfway.
//
// Dedup keys on the CANONICAL url, not the raw string: two entries for the same page in
// different string forms (trailing slash, scheme, `www.`) are one page, and each would
// otherwise pass `referencesBody` independently and emit a duplicate note.
export function scrubBody(
  body: string,
  unverified: ReadonlyArray<UnverifiedMention>,
): { body: string; annotated: number } {
  let notes = ''
  let annotated = 0
  const seen = new Set<string>()
  for (const entry of unverified) {
    if (!entry.url) continue
    const key = canonical(entry.url)
    if (seen.has(key)) continue
    seen.add(key)
    if (!referencesBody(body, entry.url)) continue
    annotated++
    notes += `> **Unverified in prose:** this report references ${entry.url}, which this run could NOT verify (${entry.reason}). Treat that reference as unconfirmed — see \`unverified\`.\n\n`
  }
  return { body: notes + body, annotated }
}
