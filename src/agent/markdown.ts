// Markdown-safety helpers for text that a MODEL controls and that gets interpolated into a
// report the caller reads as markdown.
//
// Both the report body's transparency notes (body-mentions.ts) and the text-only MCP surface
// (report-text.ts) render model-controlled fields — `unverified[].topic`/`url`/`reason`,
// `citations[].claim`/`url`, `sources[]`. Those fields are unconstrained strings, so a hostile
// or merely hallucinating synthesizer can put markdown in them. Three distinct risks, three
// helpers:
//
//   - `inline` — a field that must stay on ONE line. Collapsing whitespace means it cannot
//     contain a line break, so it cannot close its own blockquote or open a new block/heading.
//     This is the structural risk: forging a look-alike verification stamp beneath the real one.
//   - `escapeMarkdown` — a field that stays inline but must not render as live markdown, so it
//     cannot smuggle a link (`[bait](https://evil.example)`) or emphasis into the annotation.
//   - `autolinkSafe` — a field going inside a CommonMark autolink `<...>`. Backslash escapes
//     are NOT processed inside an autolink, so `escapeMarkdown` there would leak literal
//     backslashes into the URL a client copies or follows. The autolink ends at the first `>`,
//     so the only characters that can break out are `<` and `>` — strip those, and nothing
//     else needs escaping: markdown syntax inside `<...>` is inert.
//
// One copy of each, shared, because hand-rolled formatters drift — the same reason `withScheme`
// lives in one place. (The mcp.ts instance of the injection class survived an entire review
// pass precisely because it had its own copy.)

// Collapse all whitespace to single spaces, so the result can never contain a line break.
function inline(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// Escape the markdown that can be expressed INSIDE a line: emphasis, code, and — the one that
// matters — link/image syntax. Backslash-escaping is the CommonMark-sanctioned way to render a
// metacharacter literally, and these are exactly the characters that can start an inline
// construct. `\` is escaped first so it cannot itself escape a following character.
function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_[\]()<>]/g, (c) => `\\${c}`)
}

// Both at once, for a model-controlled field going into a single markdown line. Correct for
// plain prose — but NOT for text inside `<...>` (see `autolinkSafe`).
export function inlineSafe(s: string): string {
  return escapeMarkdown(inline(s))
}

// For text going inside a CommonMark autolink `<...>`. No backslashes (they are not processed
// there and would corrupt the URL), just the two characters that can terminate or forge the
// autolink, plus any line break.
export function autolinkSafe(s: string): string {
  return inline(s).replace(/[<>]/g, '')
}
