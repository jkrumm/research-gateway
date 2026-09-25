// Submit-time lint for inputs that are almost certainly a client mistake, not a question: shell
// syntax an MCP client passed through unexpanded (MCP params are never shell-expanded), or the
// CLI's `--context @file` syntax used on a door that does not read files. Measured once
// (2026-09-25): a literal `$(cat /tmp/…/context.md)` context ran a full deep job.
//
// A warning, not a refusal — a cheap guard, not a parser. The submit response carries it and
// the caller can `job_cancel` / `DELETE /research/:jobId` at once. Pure and env-free, so it is
// unit-tested directly (same convention as `admission.ts`).

const WHOLE_VALUE_PATTERNS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /^\$\([\s\S]*\)$/, what: 'an unexpanded shell command substitution `$(…)`' },
  { pattern: /^`[\s\S]*`$/, what: 'an unexpanded shell backtick substitution' },
  { pattern: /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/, what: 'an unexpanded shell variable' },
  { pattern: /^@[~./]\S*$/, what: "the CLI's `@file` syntax, which only `research --context` reads" },
]

export function inputWarnings(input: { query: string; context?: string | undefined }): string[] {
  const warnings: string[] = []
  for (const field of ['query', 'context'] as const) {
    const value = input[field]?.trim()
    if (value === undefined) continue
    const hit = WHOLE_VALUE_PATTERNS.find(({ pattern }) => pattern.test(value))
    if (!hit) continue
    warnings.push(
      `\`${field}\` is ${hit.what} — the job received it literally, not the text it points to. If that was not intended, cancel the job and resubmit with the actual text.`,
    )
  }
  return warnings
}
