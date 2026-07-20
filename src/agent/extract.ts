// Dependency-free by design (no project imports) so these two pure helpers can be
// unit-tested without booting the whole env/LLM import chain. Mirrors the convention
// documented at the top of `assemble.ts`.

// Collapse extraction padding (huge whitespace runs Readability/Tavily leave behind in
// table cells) without destroying document structure. This exact sequence was measured
// against a real failing page (mariadb.org/about/) to give a 54% size reduction while
// keeping table headers/values legible as readable runs.
export function normalizeText(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Truncate to `cap` and, when truncation happens, append an honest, actionable notice
// with the real numbers involved. A bare `[truncated]` marker is indistinguishable from
// an unreachable source to a worker — this notice makes it explicit that only the
// remainder past `cap` is missing, not the whole page.
export function capText(text: string, cap: number): string {
  if (text.length <= cap) return text
  return (
    text.slice(0, cap) +
    `\n\n[truncated: showing the first ${cap} of ${text.length} characters of this page. The remainder was not included — if the information you need is not above, it may be further down this page.]`
  )
}
