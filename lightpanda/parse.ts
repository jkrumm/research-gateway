// Reading `lightpanda fetch --dump markdown --json`.
//
// Split out from server.ts and dependency-free so it is unit-testable without spawning a
// browser — same convention as the gateway's ledger.ts / extract.ts / jina.ts.
//
// Everything here exists because lightpanda's CLI reports failure by NOT failing. Measured
// against the 0.3.6 binary on the VPS, 2026-08-02:
//
//   $ lightpanda fetch https://this-domain-does-not-exist-xyz123.com --dump markdown --json
//   exit=0
//   {"url":"...","http_status":0,"headers":[],"dump":"markdown",
//    "content":"\n# Navigation failed\n\nReason: CouldntResolveHost\n"}
//
//   $ lightpanda fetch https://www.techempower.com/nope-does-not-exist --dump markdown --json
//   exit=0
//   {"url":"...","http_status":404, ... }
//
// Exit code 0 for a dead domain, and a *synthetic markdown page* as the content. Handing that
// up the chain would file "# Navigation failed / Reason: CouldntResolveHost" as retrieved page
// text and let a citation rest on it — the same class of bug as Reddit's 8 KB shell and Jina's
// `Warning: Target URL returned error 403`. So the status field and the synthetic-page marker
// are both load-bearing, and the exit code is worth nothing.

export type RenderResult = { ok: true; text: string; status: number } | { ok: false; error: string }

// Same 200-char floor as Readability in tools.ts and parseJinaResponse, for the same reason:
// below it, what came back is a stub rather than a page.
const MIN_CONTENT_CHARS = 200

// The heading lightpanda synthesises when navigation never produced a document. It comes with
// `http_status: 0`, so the status check below already catches every case observed — this is a
// belt-and-braces check in case a future version pairs the synthetic page with a real status.
const NAVIGATION_FAILED = /^#[ \t]+Navigation failed/m
const NAVIGATION_REASON = /^Reason:[ \t]*(.+)$/m

// A page that is BOTH short and error-shaped. Both halves are load-bearing, and the reason is
// a measurement rather than caution — nine bot-hostile sites were put through this renderer to
// find out what a block actually looks like here:
//
//   - Seven answered with HTTP **403** (g2, crunchbase, indeed, ...), which the status check
//     above already rejects. The Cloudflare-style "200 with a challenge page" that this guard
//     was originally proposed for did not occur once.
//   - walmart.com answered **200 with 243 chars**: "# Sorry... We're having technical issues,
//     but we'll be back in a flash." That is the real case — a non-page that clears the
//     200-char floor by 43 characters and would be filed as retrieved content.
//   - ticketmaster.com answered **200 with 28,331 chars**, opening with "Your browser is not
//     supported. For the best experience, use any of these supported browsers: Chrome,
//     Firefox...". That banner sits on top of a fully rendered page, and the other 28k chars
//     are real. Matching on the phrase alone would have thrown all of it away.
//
// So the phrase is never enough on its own; it only counts on a page too short to be a page.
// A genuine article of under 1,000 chars is already near-worthless as a citation source, which
// is what makes the conjunction safe.
const SHORT_PAGE_CEILING = 1000
const ERROR_SHAPED =
  /having technical issues|temporarily unavailable|access denied|request blocked|are you a robot|verify you are human|checking your browser|enable javascript|too many requests|try again later/i

interface Dump {
  http_status: number
  content?: string
}

// lightpanda writes uncaught page-JS exceptions to STDOUT, not stderr, so stdout is not
// guaranteed to be JSON and is not guaranteed to be one line. Reproducible on the exact page
// this whole feature exists for:
//
//   $ lightpanda fetch https://www.techempower.com/benchmarks/ --dump markdown --json 2>/dev/null
//   {"url":"https://www.techempower.com/benchmarks/", ... }
//   Uncaught TypeError: Illegal invocation
//
// A naive JSON.parse(stdout) throws `Extra data: line 2` there — deterministically, 3/3 runs.
// So: scan lines for the first one that parses into a dump object. A JSON string can never
// contain a raw newline, so the dump is always exactly one physical line and this is safe.
function findDump(stdout: string): Dump | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null) continue
      const status = (parsed as Record<string, unknown>)['http_status']
      if (typeof status !== 'number') continue
      const content = (parsed as Record<string, unknown>)['content']
      return { http_status: status, ...(typeof content === 'string' ? { content } : {}) }
    } catch {
      // Not the dump line — page output, a truncated tail, or noise. Keep scanning.
    }
  }
  return null
}

export function parseLightpandaStdout(stdout: string): RenderResult {
  const dump = findDump(stdout)
  if (!dump) return { ok: false, error: 'lightpanda produced no parseable result' }

  const content = (dump.content ?? '').trim()

  // `http_status: 0` means navigation never completed — DNS failure, TLS failure, connection
  // refused. `content` is lightpanda's own error page, not the site's.
  if (dump.http_status === 0) {
    const reason = NAVIGATION_REASON.exec(content)?.[1]?.trim()
    return { ok: false, error: `navigation failed${reason ? `: ${reason}` : ''}` }
  }

  if (dump.http_status >= 400) {
    return { ok: false, error: `HTTP ${dump.http_status}` }
  }

  if (NAVIGATION_FAILED.test(content)) {
    const reason = NAVIGATION_REASON.exec(content)?.[1]?.trim()
    return { ok: false, error: `navigation failed${reason ? `: ${reason}` : ''}` }
  }

  if (content.length < MIN_CONTENT_CHARS) {
    return { ok: false, error: `lightpanda returned ${content.length} chars of content` }
  }

  if (content.length < SHORT_PAGE_CEILING && ERROR_SHAPED.test(content)) {
    return { ok: false, error: `page is an error notice, not content (${content.length} chars)` }
  }

  return { ok: true, text: content, status: dump.http_status }
}
