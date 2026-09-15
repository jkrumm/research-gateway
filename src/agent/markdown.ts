// Markdown-safety helpers for text that a MODEL controls and that gets interpolated into a
// report the caller reads as markdown.
//
// The report body's transparency notes (body-mentions.ts) and the text-only MCP surface
// (report-text.ts) both render model-controlled fields — `unverified[].topic`/`url`/`reason`,
// `citations[].claim`/`url`, `sources[]`. Those are unconstrained strings, so a hostile or
// merely hallucinating synthesizer can put markdown in them.
//
// There are exactly two field kinds, so there are exactly two entry points. Callers must not
// choose between the primitives: picking the wrong one has shipped the same defect twice (a URL
// run through `inlineSafe` gets backslashes that survive inside an autolink and corrupt the
// href; a prose field run through `autolinkSafe` keeps its live link syntax).
//
//   - `renderProse(s)` — a sentence-like field (`claim`, `topic`, `reason`). Collapses
//     whitespace (so it cannot contain a line break and close its own blockquote or open a new
//     block) and escapes inline markdown (so it cannot smuggle a link or emphasis).
//   - `renderUrl(s)` — a URL field (`url`, `sources[]`). Rendered as a CommonMark autolink
//     `<...>`, where markdown is inert and backslash escapes are NOT processed — so escaping
//     there would leak literal backslashes into the href a client copies or follows
//     (`wiki/Foo\(bar\)`). Only `<`/`>` are stripped, since those can terminate or forge the
//     autolink. A value that cannot be a valid autolink (it contains whitespace — e.g. a
//     model-authored `[click here](https://evil.example)` in `sources[]`'s fallback path) is
//     rendered as prose instead, which neutralizes the link syntax.
//
// One copy of each, shared, because hand-rolled formatters drift — the same reason `withScheme`
// lives in one place.

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

// A sentence-like, model-controlled field going into markdown.
export function renderProse(s: string): string {
  return escapeMarkdown(inline(s))
}

// A URL-like, model-controlled field going into markdown, as a CommonMark autolink.
export function renderUrl(s: string): string {
  const flat = inline(s)
  // A valid autolink's content is a URI with no whitespace. Anything else (the model-authored
  // `sources[]` fallback, which can carry a whole markdown link) is not safe inside `<...>`:
  // the `<` would render literally and the link syntax after it would still be parsed. Render
  // those as prose, which escapes the link.
  if (/\s/.test(flat)) return `(${escapeMarkdown(flat)})`
  return `<${flat.replace(/[<>]/g, '')}>`
}
