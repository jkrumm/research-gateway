// The text-only rendering of a research report — the string an MCP client that ignores
// `structuredContent` sees, and nothing else.
//
// Pure by construction: it depends only on `schema.js` (types) and `markdown.js` (escaping),
// never on `env.js` or the route layer. It lived in `routes/mcp.ts` until a review pass pointed
// out that importing it pulled in `env.ts`'s required-var validation, so its own test had to
// set four placeholder env vars before a dynamic import just to load the function. Same
// boundary the ledger/extract/archive modules already keep.
import type { ResearchReport } from './schema.js'
import { autolinkSafe, inlineSafe } from './markdown.js'

// Inline the report + citations + sources so text-only MCP clients get the full picture even if
// they ignore structuredContent.
export function reportText(report: ResearchReport): string {
  // Confidence is rendered per citation, and `unverified` is rendered at all, because a
  // text-only client sees ONLY this string — omitting them here reproduced issue #1's shape
  // from the client's side: every claim looked equally established.
  //
  // Every interpolated field below is model-controlled (`claim`, `url`, `topic`, `reason`,
  // `sources[]`), and this string is markdown. Two different escapes, deliberately:
  //   - URLs sit inside CommonMark autolinks `<...>`, where backslash escapes are NOT
  //     processed — `inlineSafe` there would leak literal backslashes into the href a client
  //     copies or follows (`wiki/Foo\(bar\)`). `autolinkSafe` strips only `<`/`>`.
  //   - Prose fields (`claim`, `topic`, `reason`) are plain markdown, so they get the full
  //     `inlineSafe` — without it a `reason` could inject a link or a forged heading.
  //   - `sources[]` are bare URLs, which GFM autolinks; a backslash there would corrupt the
  //     visible URL the same way, so they get `autolinkSafe` too.
  const citationLines =
    report.citations.length > 0
      ? '\n\n## Citations\n' +
        report.citations
          .map(
            (c, i) =>
              `${i + 1}. [${c.confidence}] ${inlineSafe(c.claim)} — <${autolinkSafe(c.url)}>`,
          )
          .join('\n')
      : ''
  const unverifiedLines =
    report.unverified.length > 0
      ? '\n\n## Unverified — could NOT be checked against a source\n' +
        report.unverified
          .map(
            (u) =>
              `- ${inlineSafe(u.topic)}${u.url ? ` (<${autolinkSafe(u.url)}>)` : ''} — ${inlineSafe(u.reason)}`,
          )
          .join('\n')
      : ''
  const sourcesLines =
    report.sources.length > 0
      ? '\n\n## Sources read\n' + report.sources.map((s) => `- ${autolinkSafe(s)}`).join('\n')
      : ''
  return report.report + citationLines + unverifiedLines + sourcesLines
}
