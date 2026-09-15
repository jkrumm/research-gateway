// Markdown-safety helpers for text that a MODEL controls and that gets interpolated into a
// report the caller reads as markdown.
//
// Both the report body's transparency notes (body-mentions.ts) and the text-only MCP surface
// (routes/mcp.ts) render model-controlled fields — `unverified[].topic`/`url`/`reason`,
// `citations[].claim`/`url`, `sources[]`. Those fields are unconstrained strings, so a hostile
// or merely hallucinating synthesizer can put markdown in them. Two distinct risks, two
// helpers:
//
//   - `inline` — a field that must stay on ONE line. Collapsing whitespace means it cannot
//     contain a line break, so it cannot close its own blockquote or open a new block/heading.
//     This is the structural risk: forging a look-alike verification stamp beneath the real one.
//   - `escapeMarkdown` — a field that stays inline but must not render as live markdown, so it
//     cannot smuggle a link (`[bait](https://evil.example)`) or emphasis into the annotation.
//
// One copy of each, shared, because two hand-rolled formatters drift — the same reason
// `withScheme` lives in one place.

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

// Both at once, for a model-controlled field going into a single markdown line.
export function inlineSafe(s: string): string {
  return escapeMarkdown(inline(s))
}
