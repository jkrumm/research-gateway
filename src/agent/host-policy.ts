// Per-host chain policy — how hard to try an origin before giving up on it, and how many
// probes it may cost. A handful of hosts fingerprint-block this crawler's plain fetch (and
// the lightpanda render) on every attempt: every probe still spends IP reputation even when it
// fails, so for those hosts the right answer is to skip straight past origin/render to the
// steps that don't hit our IP (Tavily Extract, yt-dlp, Wayback) or to a human solver.
//
// Table entries need a measurement, same convention as site-adapters.ts's header comment — a
// host earns an entry by being probed and shown to fail, not by reputation alone.

export type ChainStage = 'origin' | 'render' | 'extract' | 'human' | 'archive'

export interface HostPolicy {
  minIntervalMs: number
  maxConcurrency: number
  skip: readonly ChainStage[]
  humanSolve: boolean
  note?: string
}

export const DEFAULT_HOST_POLICY: HostPolicy = {
  minIntervalMs: 1000,
  maxConcurrency: 2,
  skip: [],
  humanSolve: true,
}

interface HostPolicyEntry extends Partial<Omit<HostPolicy, 'note'>> {
  note: string
}

// Re-measured 2026-09-26 (mini), superseding the 2026-08-17/18 pass:
//   - ebay.com / ebay.de: Akamai 403 on both a plain fetch AND a TLS-impersonating fetch —
//     no origin rung can pass this without a real browser/human.
//   - g2.com: Cloudflare 403 on both a plain and an impersonated fetch — same shape as ebay.
//   - mpb.com: serves a Cloudflare managed challenge ("MPB - Security check", 403 +
//     cf-mitigated: challenge) to both a plain AND an impersonated fetch — origin/render stay
//     skipped.
//   - idealo.de: REMOVED from this table. A plain fetch 403s, but a TLS-impersonating fetch
//     returns the real page — origin is not hopeless here, it just needs a better rung than
//     plain fetch (an `impit`-style step slots in at the seam fetch-chain.ts leaves right
//     after step-1 block detection). Leaving origin enabled lets that rung reach it once added.
// Shared by every host below: origin AND render are both hopeless (measured to fail on a plain
// AND a TLS-impersonating fetch alike), so both are skipped. `humanSolve` is left off each
// entry — `DEFAULT_HOST_POLICY.humanSolve` is already `true`, and repeating it on every row was
// redundant with the spread these entries get merged over in `policyFor`.
const HARD_BLOCKED = { skip: ['origin', 'render'] as const }

const POLICY_TABLE: Record<string, HostPolicyEntry> = {
  'ebay.com': {
    ...HARD_BLOCKED,
    note: 'Akamai 403s a plain AND a TLS-impersonating fetch (measured 2026-09-26) — every probe spends IP reputation for nothing.',
  },
  'ebay.de': {
    ...HARD_BLOCKED,
    note: 'Akamai 403s a plain AND a TLS-impersonating fetch (measured 2026-09-26) — every probe spends IP reputation for nothing.',
  },
  'mpb.com': {
    ...HARD_BLOCKED,
    note: 'Cloudflare managed challenge ("MPB - Security check", 403 + cf-mitigated: challenge) on both a plain and an impersonated fetch (measured 2026-09-26).',
  },
  'g2.com': {
    ...HARD_BLOCKED,
    note: 'Cloudflare 403s a plain AND a TLS-impersonating fetch (measured 2026-09-26) — same shape as ebay.com.',
  },
}

/**
 * Table lookup walks labels from the full host down to the last two labels (no tldts
 * dependency — `co.uk`-style suffixes are not split specially, so an entry for one of those
 * needs its own two-label key), first match wins, merged over the default.
 */
export function policyFor(host: string): HostPolicy {
  const labels = host.toLowerCase().split('.').filter(Boolean)
  for (let i = 0; i <= labels.length - 2; i++) {
    const entry = POLICY_TABLE[labels.slice(i).join('.')]
    if (entry) return { ...DEFAULT_HOST_POLICY, ...entry }
  }
  return DEFAULT_HOST_POLICY
}
