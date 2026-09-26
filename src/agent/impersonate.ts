// The TLS/HTTP2 browser-impersonation rung — `impit` (napi-rs, prebuilt bindings for
// darwin-arm64 and linux-x64-musl, no postinstall script). Slots into fetch-chain.ts right
// after step 1's block detection: a handful of hosts (idealo.de, measured 2026-09-26) 403 a
// plain fetch's TLS/HTTP2 fingerprint but serve the real page to a genuine Chrome handshake —
// no JS execution needed, so this is cheaper and gentler than the lightpanda render step.
//
// Two independent things live here:
//   1. `impersonatedFetch` — a lazy singleton `Impit` client and a Response-compatible fetch
//      wrapper around it. Never throws on its own missing native binding: it reports
//      unavailable once (logged) and degrades forever after, matching the fetch chain's own
//      "NEVER throws" contract (fetch-chain.ts's header comment) — a caller that awaits this
//      and gets a rejected promise on a bad host is exactly the same shape as a network error
//      from `fetch`, and is caught the same way.
//   2. Pure, bounded per-host learning state (`createImpersonationMemory`) — which hosts have
//      been OBSERVED (this process, this run) to need impersonation, so a chain for a host
//      already learned skips straight to the impersonated fetch instead of spending a
//      plain-fetch probe that is known to 403 first. Same cap/TTL/eviction shape as
//      host-gate.ts's per-host map, for the same reason: a real job's host set is a few dozen
//      at most, and this is a safety valve, not a tuning knob. Dependency-injected (clock) and
//      factory-built, same convention as `createHostGate` — `defaultImpersonationMemory` is the
//      one production shares across every worker; fetch-chain.ts's tests inject their own so
//      learned state never leaks between test cases.
//
// NO custom User-Agent is ever set on the impersonated fetch — the whole point of `browser:
// 'chrome'` is that the TLS/HTTP2 fingerprint and every impersonation header (Chrome's own
// User-Agent included) come from the same coherent profile. Overriding the UA while keeping
// Chrome's TLS handshake is itself a tell a fingerprinting WAF can key on.

import type { Impit } from 'impit'
import { log } from '../lib/log.js'

// `undefined` = not yet attempted, otherwise the (single, shared) in-flight/settled load. The
// PROMISE itself is memoized, not just its resolved value — two concurrent first calls to
// `getImpitClient` must share one `import('impit')` + one `Impit` construction, never two: a
// check-then-act on a resolved value (`if (impitClient !== undefined) ...` guarding an `await`
// before the assignment) leaves a window where both concurrent callers see "not yet attempted"
// and each imports/constructs its own client. Assigning `impitClientPromise` synchronously,
// before anything is awaited, closes that window — the second concurrent call always finds the
// first call's promise already in place.
let impitClientPromise: Promise<Impit | null> | undefined

// Test-only — counts how many times `loadImpitClient` actually ran (never in production code),
// so impersonate.test.ts can prove two concurrent `getImpitClient` callers share ONE load
// rather than each triggering their own `import('impit')` + `Impit` construction.
let loadAttempts = 0

// A DYNAMIC import, never a static one: impit's entry `require`s its napi binding at module
// load, so a static import that fails to find the binding (a platform package missing from the
// lockfile, an ABI mismatch on the VPS's alpine image) would take the whole gateway down at
// boot instead of just this rung.
async function loadImpitClient(): Promise<Impit | null> {
  loadAttempts++
  try {
    const { Impit } = await import('impit')
    // `followRedirects: false` at the instance level — every caller in this chain wants
    // `redirect: 'manual'` per-request anyway (SSRF: every hop must be re-validated by hand,
    // fetch-chain.ts's `safeFetch`), so the instance default is set to match rather than rely
    // on every call site overriding it.
    return new Impit({ browser: 'chrome', followRedirects: false })
  } catch (err) {
    log('fetch.impersonate_unavailable', { error: String(err) })
    return null
  }
}

async function getImpitClient(): Promise<Impit | null> {
  // Synchronous check-and-set, no `await` between them — this is what makes the memoization
  // race-free: `loadImpitClient()` is called (and its promise stored) before control ever
  // yields back to the event loop, so a second concurrent call always observes the first
  // call's promise already assigned, win or lose.
  if (impitClientPromise === undefined) impitClientPromise = loadImpitClient()
  return impitClientPromise
}

/**
 * A Response-compatible fetch through the impersonated Chrome TLS/HTTP2 fingerprint. Redirects
 * are always manual — the caller (fetch-chain.ts's `safeFetch`) re-validates every hop against
 * the SSRF guard by hand, exactly as it does for the plain-fetch rung; letting impit follow a
 * redirect itself would skip that check. Rejects (does not throw synchronously) when the
 * native binding never loaded, or on any transport error — both are ordinary fetch failures to
 * the caller, which already wraps this in the same try/catch as the plain fetch.
 */
export async function impersonatedFetch(url: string, init: { signal?: AbortSignal | undefined } = {}): Promise<Response> {
  const client = await getImpitClient()
  if (!client) throw new Error('impersonation unavailable: impit native binding failed to load')
  // Omitted rather than set to `undefined` — `exactOptionalPropertyTypes` treats an explicit
  // `signal: undefined` as distinct from the key being absent, and impit's own RequestInit
  // wants `AbortSignal`, never `| undefined`.
  const res = await client.fetch(url, { redirect: 'manual', ...(init.signal ? { signal: init.signal } : {}) })
  assertResponseLike(res)
  return res
}

// The fetch chain relies on exactly three fields of whatever impit's `.fetch()` resolves to:
// `status` (a number, read by classifyBlock/looksLikeSuccess), `headers.get` (a function, read
// for Retry-After/content-type/etc.), and `body` (present — possibly `null` for an empty
// response, but the KEY must exist; a stream the chain can read like a real Response body). A
// bare `as unknown as Response` would let a future impit release silently rename or drop any of
// these and still type-check, failing downstream in a far harder to diagnose way (a `.get` call
// on `undefined`, deep inside fetch-chain.ts, instead of here). This throws the same shape of
// error a plain `fetch()` failure already produces, which the caller's existing try/catch around
// this rung already handles like any other transport error.
function assertResponseLike(res: unknown): asserts res is Response {
  const candidate = res as { status?: unknown; headers?: { get?: unknown } } | null | undefined
  const hasBody = typeof candidate === 'object' && candidate !== null && 'body' in candidate
  if (typeof candidate?.status !== 'number' || typeof candidate.headers?.get !== 'function' || !hasBody) {
    throw new Error('impersonation unavailable: impit response does not match the Fetch Response surface')
  }
}

export { createImpersonationMemory, defaultImpersonationMemory, type ImpersonationMemory } from './impersonate-memory.js'

// Test-only seam — see impersonate.test.ts. `getImpitClient` is otherwise module-private;
// exposing it (plus the load counter and a reset) is what lets the memoization race be
// asserted directly, without going through a real network fetch.
export const _test = {
  getImpitClient,
  get loadAttempts(): number {
    return loadAttempts
  },
  reset(): void {
    impitClientPromise = undefined
    loadAttempts = 0
  },
}
