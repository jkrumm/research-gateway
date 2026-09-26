#!/usr/bin/env bun
// Runs LOCALLY ON THE MINI, spawned directly by src/agent/human-solve.ts
// (`Bun.spawn([process.execPath, <abs path to this file>], ...)` — no ssh, this process IS
// the browser automation). The one repo import below (`../src/lib/ssrf.js`, env-free — see its
// own header) is deliberate: it runs from the repo checkout, so there is no reason to keep a
// second, weaker copy of the SSRF guard here.
//
// Why local, not the MacBook: cf_clearance must be issued to the IP that later fetches also
// use — the mini's — and the MacBook is an IU-managed device on a corporate network the fetch
// egress must never touch (measured 2026-09-26: TLS resets against Cloudflare-fronted
// example.com). The human still solves visually on the MacBook, over Screen Sharing into the
// mini's console session (:5900) — human-solve.ts is what asks them to open that, this file
// only drives the local Chrome and never talks to the MacBook itself.
//
// Protocol: one request JSON object on stdin, one result JSON object as the LAST line of
// stdout. Everything else — progress, errors, the whole play-by-play — goes to stderr, so a
// chatty run never corrupts the one line of protocol the gateway parses.
//
// Pure helpers are exported so bin/solver.test.ts can pin them without a real Chrome session;
// `main()` (the I/O boundary: stdin, Chrome's CDP endpoint, osascript, signals) only runs when
// this file is executed directly (`if (import.meta.main)`).

import { unlinkSync, readFileSync, writeFileSync, linkSync, statSync, renameSync } from 'node:fs'
import { assertPublicHttpUrl } from '../src/lib/ssrf.js'

export interface SolverRequest {
  v: 1
  mode: 'solve' | 'fetch' | 'warm'
  url: string
  timeoutMs: number
  /** The gateway's src/lib/safe-proxy.ts port (env.HUMAN_SOLVE_PROXY_PORT) — Chrome's own
   * `--proxy-server` flag, so every HTTP(S)/WebSocket byte it sends anywhere (not just the one
   * URL this request names) is decided against the SSRF guard; WebRTC is separately restricted
   * to proxied UDP only (see chromeLaunchArgs' `disable_non_proxied_udp` flags) — those are the
   * only two network paths page JS in Chrome can reach, no other raw-socket API exists to it.
   * Carried per-request (never read from env here — this file stays env-free, see the header)
   * so a proxy port change on the gateway side is picked up on the very next request, no
   * restart of this script required. */
  proxyPort: number
}

type SolverOutput =
  | { ok: true; html: string; finalUrl: string; mode: 'solved' | 'cleared'; status?: number }
  | { ok: true; mode: 'warm' }
  | { ok: false; reason: string }

// ── Config ────────────────────────────────────────────────────────────────────────

// 9333 (the original pick) collided with an existing Colima/Lima ssh port-forward measured on
// the MacBook — kept at 9422 now that the browser itself moved to the mini, since a fixed,
// well-known port is still simpler to reason about than probing for a free one.
const CDP_PORT = 9422
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`
const PROFILE_DIR = `${process.env['HOME']}/.research-gateway/solver-chrome`
const CHROME_LAUNCH_WAIT_MS = 20_000
const STABLE_POLL_MS = 1_000
const STABLE_CHECKS_REQUIRED = 2
const SETTLE_GAP_MS = 1_500
const FETCH_CHALLENGE_ESCALATE_MS = 25_000
const MAX_HTML_CHARS = 5 * 1024 * 1024
// The parent's own cap on THIS process's stdout (human-solve.ts's MAX_STDOUT_BYTES, 8 MiB) is a
// raw BYTE cap on the printed line, not on html.length — JSON.stringify can escape a single
// source char to up to 6 bytes (a control character becomes `\u00XX`; `"`/`\` become 2 bytes
// each), so an html string safely under MAX_HTML_CHARS can still serialize past that byte cap if
// it happens to be escape-heavy, truncating the one line of protocol the parent parses
// (parseSolverOutput's last-line scan then finds nothing valid and falls back to a generic
// 'error'). capHtml below caps the SERIALIZED line's byte length, not html.length, closing that
// gap regardless of escaping density. Kept in sync with human-solve.ts's MAX_STDOUT_BYTES by
// comment, not a runtime import — solver.ts stays a standalone spawned script (see this file's
// header on why importing across that boundary is deliberately avoided); comfortably below 8 MiB
// for the JSON structure overhead (finalUrl, mode, key names) around the html value.
const MAX_OUTPUT_LINE_BYTES = 6 * 1024 * 1024
const MIN_TEXT_LEN = 200
const CDP_CALL_TIMEOUT_MS = 10_000
// An empty tab title is ambiguous — a genuinely still-loading page, OR a plain-text document
// (no <title>) that will never get one. Only the first few seconds of "empty" count as
// "still loading a challenge"; past that, fall through to the text/html-based looksChallenged
// check, which reads real page content instead of a title that will just never appear.
const EMPTY_TITLE_GRACE_MS = 10_000
// Sibling to PROFILE_DIR, not inside it — PROFILE_DIR itself may not exist yet before Chrome's
// first launch creates it.
const CHROME_LOCK_PATH = `${PROFILE_DIR}.lock`
const CHROME_LOCK_ACQUIRE_TIMEOUT_MS = 20_000
const CHROME_LOCK_POLL_MS = 200
// A lock file whose pid field never parsed is either mid-write by a genuinely-live racer
// (impossible with the atomic write-then-link scheme `acquireChromeLaunchLock` uses below, but
// kept as a brief grace period in case a lock from an older build of this script is ever seen)
// or permanently corrupt. Either way, treat it as live only this briefly.
const CHROME_LOCK_STALE_UNPARSEABLE_MS = 2_000
// Backstop against pid reuse: if the SAME pid the lock names has since been recycled by an
// unrelated process, `isPidAlive` alone would wrongly call the lock live forever. No real
// Chrome launch legitimately holds this lock anywhere near this long, so age alone is
// sufficient grounds to reclaim it.
const CHROME_LOCK_STALE_AGE_MS = CHROME_LAUNCH_WAIT_MS + 10_000

// Sidecar recording the flags the CURRENTLY RUNNING Chrome was last launched with — the
// profile directory persists across launches but command-line flags don't, so a Chrome left
// running from before a proxy port change (or before this proxy existed at all) would silently
// go on browsing unfiltered. Compared on every `ensureChrome` call; a mismatch means killing
// that instance and relaunching with the flags this run actually needs.
const LAUNCH_ARGS_PATH = `${PROFILE_DIR}.launch-args.json`
// Bumped whenever chromeLaunchArgs() gains a flag that changes what an ALREADY-RUNNING instance
// can reach — the proxy port alone doesn't detect that: an instance launched before the WebRTC
// flags below were added would keep matching on proxyPort even though it still leaks direct
// WebRTC UDP. Compared alongside proxyPort in the sidecar (see `launchArgsMatch`) so any flag
// change forces a relaunch, not just a port change. v3 added `--start-maximized` — cosmetic, not
// a network-reach change, but still needs a relaunch to take effect on an already-running
// instance, so it goes through the same comparison rather than a separate mechanism.
const LAUNCH_ARGS_VERSION = 3
// How long to wait for a graceful SIGTERM exit before escalating to SIGKILL when replacing a
// stale (wrongly-flagged) Chrome instance.
const CHROME_KILL_WAIT_MS = 5_000

// Sidecar recording every tab THIS script opened, keyed by CDP target id, with the time it was
// opened — so a future run can sweep tabs an earlier, now-dead run leaked (a hard kill between
// `openTab` and the `finally`'s `closeTab`) without ever touching a tab another CONCURRENT run
// still has open. Only a tab recorded here AND older than `ORPHAN_TAB_MAX_AGE_MS` is swept.
const TABS_FILE_PATH = `${PROFILE_DIR}.tabs.json`
// Deliberately generous and independent of any caller's actual wait budget — this script is
// env-free and has no visibility into `HUMAN_SOLVE_WAIT_MS` — comfortably above the default
// 5-minute human-solve budget so a tab still within it is never mistaken for orphaned.
const ORPHAN_TAB_MAX_AGE_MS = 15 * 60 * 1000

// ── Pure helpers (exported for bin/solver.test.ts) ───────────────────────────────

export type ValidatedRequest = { ok: true; value: SolverRequest } | { ok: false; reason: string }

// The real, DNS-resolving SSRF guard — the same one the fetch chain re-checks on every
// redirect hop (fetch-chain.ts). No second, weaker reimplementation here: this script sees an
// attacker-influenced URL (LLM-chosen) both on the way in AND on the way out (a Chrome-followed
// redirect's settled `location.href` — see the finalUrl check in processRequest below), so both
// checks go through this one shared, tested guard.
export async function checkUrlSafety(raw: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await assertPublicHttpUrl(raw)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `bad_request: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function validateRequest(raw: unknown): Promise<ValidatedRequest> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'bad_request: not an object' }
  const r = raw as Record<string, unknown>
  if (r['v'] !== 1) return { ok: false, reason: 'bad_request: unsupported v' }
  const mode = r['mode']
  if (mode !== 'solve' && mode !== 'fetch' && mode !== 'warm') return { ok: false, reason: 'bad_request: bad mode' }
  const url = r['url']
  if (typeof url !== 'string' || url.length === 0) return { ok: false, reason: 'bad_request: missing url' }
  const timeoutMs = r['timeoutMs']
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { ok: false, reason: 'bad_request: bad timeoutMs' }
  }
  const proxyPort = r['proxyPort']
  if (typeof proxyPort !== 'number' || !Number.isInteger(proxyPort) || proxyPort <= 0 || proxyPort > 65_535) {
    return { ok: false, reason: 'bad_request: bad proxyPort' }
  }
  const urlCheck = await checkUrlSafety(url)
  if (!urlCheck.ok) return urlCheck
  return { ok: true, value: { v: 1, mode, url, timeoutMs, proxyPort } }
}

// Empty title while the page is still loading counts as "challenged" too — but only within
// EMPTY_TITLE_GRACE_MS of the request starting. Past that grace window an empty title is just
// as likely a plain-text/no-<title> document that will never get one, so it falls through to
// looksChallenged's text/html-based check instead of resetting the stability counter forever.
const CHALLENGE_TITLE_RE =
  /just a moment|attention required|checking your browser|verify you are human|access denied|pardon our interruption|robot or human|ddos-guard|security check|one more step|please wait/i

export function isChallengeTitle(title: string, elapsedMs = 0): boolean {
  const trimmed = title.trim()
  if (trimmed === '') return elapsedMs < EMPTY_TITLE_GRACE_MS
  return CHALLENGE_TITLE_RE.test(trimmed)
}

const CHALLENGE_HTML_RE =
  /cf-chl|cf-mitigated|just a moment|verify you are human|checking your browser|enable javascript and cookies/i

export function looksChallenged(html: string, textLen: number): boolean {
  if (textLen < MIN_TEXT_LEN) return true
  return CHALLENGE_HTML_RE.test(html.slice(0, 20_000))
}

export function capHtml(html: string): string {
  let candidate = html.length <= MAX_HTML_CHARS ? html : html.slice(0, MAX_HTML_CHARS)
  // Measure the ACTUAL serialized byte length rather than assume a fixed escape ratio — shrink
  // proportionally to the overshoot (one pass handles the common case: a uniformly escape-heavy
  // string) and repeat for anything pathological enough to need a second cut.
  for (;;) {
    const serializedLen = Buffer.byteLength(JSON.stringify(candidate))
    if (serializedLen <= MAX_OUTPUT_LINE_BYTES) return candidate
    const ratio = MAX_OUTPUT_LINE_BYTES / serializedLen
    const nextLen = Math.floor(candidate.length * ratio * 0.98) // 2% safety margin per pass
    if (nextLen >= candidate.length || nextLen <= 0) return candidate.slice(0, Math.max(0, nextLen))
    candidate = candidate.slice(0, nextLen)
  }
}

// ── I/O boundary (not unit-tested — real Chrome) ─────────────────────────────────

function logErr(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

async function isChromeUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(2_000) })
    return res.ok
  } catch {
    return false
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the pid exists but is owned by someone else — still alive. Any other error
    // (ESRCH: no such process) means the previous lock holder is gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Creates CHROME_LOCK_PATH with `content` ATOMICALLY: a plain open+write+close leaves a window
// where the file exists but is still empty, so a concurrent racer's `readFileSync` can observe
// a lock with no pid in it — indistinguishable from corruption. Writing to a unique temp path
// first, then `linkSync`ing it into place, means the path only ever appears already holding its
// final content: `linkSync` either succeeds (we hold the lock) or fails EEXIST (someone already
// does), never a third, half-written state.
function tryCreateLockAtomically(path: string, content: string): boolean {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    writeFileSync(tmpPath, content)
    try {
      linkSync(tmpPath, path)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    } finally {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort — the link (if it succeeded) is a separate directory entry for the same
        // inode, so removing the temp name never touches the lock itself.
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

// True if the lock at `path` is safe to reclaim: its pid is gone, its content never parsed past
// a brief grace window, or it is simply older than any real launch ever legitimately takes
// (the pid-reuse backstop — see CHROME_LOCK_STALE_AGE_MS).
function isLockStale(path: string): boolean {
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return false // vanished under us — not stale, just gone; the create loop will retry
  }
  const age = Date.now() - mtimeMs
  if (age >= CHROME_LOCK_STALE_AGE_MS) return true

  let content: string
  try {
    content = readFileSync(path, 'utf-8').trim()
  } catch {
    return false
  }
  const pid = parseInt(content, 10)
  if (Number.isNaN(pid)) return age >= CHROME_LOCK_STALE_UNPARSEABLE_MS
  return !isPidAlive(pid)
}

// Serializes Chrome *launches* only — a concurrent 'solve' and up to two 'fetch'/'warm' runs
// otherwise each race `open -na` against the same profile/port the instant none of them sees
// `isChromeUp()` yet. A crashed holder can't wedge this forever (see `isLockStale` above); the
// stale file is RENAMED out of the way, never unlinked — renaming is the atomic step that lets
// exactly one racer win a takeover, where unlinking would let several racers all observe ENOENT
// and each believe THEY cleared it, with no ordering between their subsequent creates at all.
async function acquireChromeLaunchLock(): Promise<(() => void) | null> {
  const deadline = Date.now() + CHROME_LOCK_ACQUIRE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (tryCreateLockAtomically(CHROME_LOCK_PATH, String(process.pid))) {
      return () => {
        try {
          unlinkSync(CHROME_LOCK_PATH)
        } catch {
          // best effort
        }
      }
    }
    if (isLockStale(CHROME_LOCK_PATH)) {
      try {
        renameSync(CHROME_LOCK_PATH, `${CHROME_LOCK_PATH}.stale.${process.pid}.${Date.now()}`)
      } catch {
        // Lost the takeover race (or the file is already gone) — loop and retry the normal
        // create path; no need to clean up the graveyard file, it's inert and harmless.
      }
      continue
    }
    await sleep(CHROME_LOCK_POLL_MS)
  }
  return null
}

function chromeLaunchArgs(proxyPort: number): string[] {
  return [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    // So Screen Sharing shows essentially one browser window during a human solve — the human
    // is asked to click through a challenge over VNC, not to first find and resize the window.
    '--start-maximized',
    // Chrome's HTTP(S) and WebSocket traffic — not just the one URL it was told to open, every
    // subsequent navigation, redirect, and fetch() a page's own script issues too — is decided
    // by src/lib/safe-proxy.ts against the SSRF guard's table. `<-loopback>` removes Chrome's
    // IMPLICIT bypass-list entry for loopback destinations, so a page redirecting or fetch()-ing
    // to localhost/127.0.0.1 is refused by the proxy too, instead of going direct.
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    // WebRTC is a SEPARATE network path the proxy flags above never touch: a page could
    // otherwise open a direct UDP/TCP connection via getUserMedia/RTCPeerConnection straight
    // past the HTTP(S) proxy, without DNS or any SSRF check ever seeing it. These restrict
    // WebRTC's own IP/candidate handling to proxied traffic only (`force-` covers a Chrome
    // policy that would otherwise lock the plain flag; both are kept for the same defense-in-
    // depth reason LAUNCH_ARGS_VERSION exists). This is the one other network path page JS in
    // Chrome can reach — there is no raw TCP/UDP socket API available to it beyond these two.
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ]
}

function readLaunchArgs(): { proxyPort: number; version: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(LAUNCH_ARGS_PATH, 'utf-8')) as { proxyPort?: unknown; version?: unknown }
    if (typeof parsed.proxyPort !== 'number') return undefined
    // A sidecar written before LAUNCH_ARGS_VERSION existed has no `version` field at all —
    // treated as version 1 (the pre-WebRTC-flags launch args), never as a match for the
    // current version, so that instance is always seen as stale and relaunched.
    return { proxyPort: parsed.proxyPort, version: typeof parsed.version === 'number' ? parsed.version : 1 }
  } catch {
    return undefined
  }
}

// Whether the CURRENTLY RUNNING Chrome (per the sidecar) was launched with exactly the flags
// this run needs — both the proxy port AND the launch-args version, so a version bump (a new
// flag added to chromeLaunchArgs) forces a relaunch even when the proxy port itself hasn't
// changed.
function launchArgsMatch(proxyPort: number): boolean {
  const recorded = readLaunchArgs()
  return recorded !== undefined && recorded.proxyPort === proxyPort && recorded.version === LAUNCH_ARGS_VERSION
}

function writeLaunchArgs(proxyPort: number): void {
  try {
    writeFileSync(LAUNCH_ARGS_PATH, JSON.stringify({ proxyPort, version: LAUNCH_ARGS_VERSION }))
  } catch (err) {
    logErr('write_launch_args_failed', { error: String(err) })
  }
}

// The profile directory persists across launches, but command-line flags do not — a Chrome
// left running from before a proxy port change (or from before this proxy existed at all)
// would silently go on browsing UNFILTERED forever. Kills and relaunches whenever the running
// instance's recorded launch args don't match what this run needs.
async function killRunningChrome(): Promise<void> {
  let pid: number | null = null
  try {
    const proc = Bun.spawn(['pgrep', '-f', `remote-debugging-port=${CDP_PORT}`], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const parsed = parseInt(out.trim().split('\n')[0] ?? '', 10)
    pid = Number.isFinite(parsed) ? parsed : null
  } catch {
    pid = null
  }
  if (pid === null) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + CHROME_KILL_WAIT_MS
  while (Date.now() < deadline) {
    if (!(await isChromeUp())) return
    await sleep(300)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // best effort — it may have exited between the last isChromeUp() check and here
  }
}

// Which action to take on a running-but-flag-mismatched Chrome, given whether the launch lock
// was actually acquired and whether the mismatch is STILL there once held. Extracted as a pure
// decision so the "only kill while holding the lock" rule is unit-testable without a real Chrome
// process or a real lock file: killing blind on a lock-acquire timeout would race a launch
// already in flight under another racer's held lock, with no re-check of what THAT racer may
// have already fixed.
export type StaleChromeAction = 'already-fixed' | 'kill' | 'give-up-fallthrough'

export function decideStaleChromeAction(params: { lockAcquired: boolean; stillMismatched: boolean }): StaleChromeAction {
  if (!params.lockAcquired) return 'give-up-fallthrough'
  if (!params.stillMismatched) return 'already-fixed'
  return 'kill'
}

// Chrome >=136 only allows remote debugging on a non-default user-data-dir, so this is a
// dedicated profile, deliberately separate from the owner's everyday Chrome on the mini — a
// second running instance, not a second window of the first. Left running afterward on
// purpose (keeps solved cookies warm for the CLEARED_TTL window human-solve-state.ts tracks).
async function ensureChrome(proxyPort: number): Promise<boolean> {
  if (await isChromeUp()) {
    if (launchArgsMatch(proxyPort)) return true
    // Already running, but not with the flags THIS run needs (a proxy port change, a
    // LAUNCH_ARGS_VERSION bump, or an instance that predates the sidecar entirely). Never
    // browse through it as-is — but never KILL it without holding the launch lock either: a
    // lock-acquire timeout means another racer may be mid-launch, and killing blind here would
    // race that launch with no ordering guarantee at all.
    logErr('stale_chrome_relaunch', { proxyPort })
    const killLock = await acquireChromeLaunchLock()
    const action = decideStaleChromeAction({ lockAcquired: killLock !== null, stillMismatched: !launchArgsMatch(proxyPort) })
    if (action === 'kill') {
      try {
        await killRunningChrome()
      } finally {
        killLock?.()
      }
    } else {
      if (action === 'give-up-fallthrough') logErr('chrome_lock_failed_for_relaunch')
      killLock?.() // no-op when the lock was never acquired; releases it when 'already-fixed'
    }
  }

  const releaseLock = await acquireChromeLaunchLock()
  if (!releaseLock) {
    logErr('chrome_lock_failed')
    // Another racer may have finished launching while we waited for the lock — one more look
    // before giving up.
    return await isChromeUp()
  }
  try {
    // Re-check now that we actually hold the lock: whoever held it before us may already have
    // finished the launch with the flags we need.
    if ((await isChromeUp()) && launchArgsMatch(proxyPort)) return true
    logErr('launching_chrome', { profileDir: PROFILE_DIR, proxyPort })
    Bun.spawn(['open', '-na', 'Google Chrome', '--args', ...chromeLaunchArgs(proxyPort)], { stdout: 'ignore', stderr: 'ignore' })
    const deadline = Date.now() + CHROME_LAUNCH_WAIT_MS
    while (Date.now() < deadline) {
      if (await isChromeUp()) {
        writeLaunchArgs(proxyPort)
        return true
      }
      await sleep(500)
    }
    return false
  } finally {
    releaseLock()
  }
}

// True if `port` (the SSRF-filtering proxy, src/lib/safe-proxy.ts) is actually listening — ANY
// HTTP response (even a 403 policy refusal, which this bare same-origin probe will get) proves
// it is; only a connection failure means it is not. Checked before Chrome is even launched: the
// whole point of the proxy is that Chrome can never browse without it, so a solver that can't
// confirm it's up must refuse to run rather than fail open.
async function isProxyListening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
    return true
  } catch {
    return false
  }
}

// ── Orphan tab tracking ───────────────────────────────────────────────────────────
// A hard kill between `openTab` and its `finally`'s `closeTab` leaks a tab in the (long-lived,
// deliberately never-restarted) solver Chrome forever. Recorded here, next to the profile, so a
// LATER run can sweep it — but only once it's unambiguously abandoned (older than
// ORPHAN_TAB_MAX_AGE_MS); a tab any other concurrent run still legitimately has open is never
// touched. Best-effort throughout: a read/write race with another concurrent run at worst
// leaves one entry briefly stale, never a currently-open tab that gets swept.

function readTabRegistry(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(TABS_FILE_PATH, 'utf-8')) as Record<string, number>
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function writeTabRegistry(registry: Record<string, number>): void {
  try {
    writeFileSync(TABS_FILE_PATH, JSON.stringify(registry))
  } catch (err) {
    logErr('write_tab_registry_failed', { error: String(err) })
  }
}

function recordTabOpened(id: string): void {
  const registry = readTabRegistry()
  registry[id] = Date.now()
  writeTabRegistry(registry)
}

function recordTabClosed(id: string): void {
  const registry = readTabRegistry()
  if (id in registry) {
    delete registry[id]
    writeTabRegistry(registry)
  }
}

async function sweepOrphanTabs(): Promise<void> {
  const registry = readTabRegistry()
  const now = Date.now()
  const stale = Object.entries(registry).filter(([, openedAt]) => now - openedAt >= ORPHAN_TAB_MAX_AGE_MS)
  if (stale.length === 0) return
  for (const [id] of stale) {
    await closeTab(id)
    delete registry[id]
  }
  writeTabRegistry(registry)
}

async function openTab(url: string): Promise<{ id: string; wsUrl: string } | null> {
  const encoded = encodeURIComponent(url)
  let res: Response
  try {
    res = await fetch(`${CDP_BASE}/json/new?${encoded}`, { method: 'PUT', signal: AbortSignal.timeout(10_000) })
    if (res.status === 405) {
      res = await fetch(`${CDP_BASE}/json/new?${encoded}`, { method: 'GET', signal: AbortSignal.timeout(10_000) })
    }
  } catch (err) {
    logErr('open_tab_failed', { error: String(err) })
    return null
  }
  if (!res.ok) {
    logErr('open_tab_failed', { status: res.status })
    return null
  }
  let data: { id?: string; webSocketDebuggerUrl?: string }
  try {
    data = (await res.json()) as { id?: string; webSocketDebuggerUrl?: string }
  } catch (err) {
    logErr('open_tab_failed', { error: `unparseable response: ${String(err)}` })
    return null
  }
  if (!data.id || !data.webSocketDebuggerUrl) {
    logErr('open_tab_failed', { error: 'no id/webSocketDebuggerUrl in response' })
    return null
  }
  return { id: data.id, wsUrl: data.webSocketDebuggerUrl }
}

async function listTargets(): Promise<Array<{ id: string; title: string; url: string }>> {
  try {
    const res = await fetch(`${CDP_BASE}/json/list`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return []
    return (await res.json()) as Array<{ id: string; title: string; url: string }>
  } catch {
    return []
  }
}

async function activateTab(id: string): Promise<void> {
  try {
    await fetch(`${CDP_BASE}/json/activate/${id}`, { signal: AbortSignal.timeout(5_000) })
  } catch {
    // best effort
  }
}

async function closeTab(id: string): Promise<void> {
  try {
    await fetch(`${CDP_BASE}/json/close/${id}`, { signal: AbortSignal.timeout(5_000) })
  } catch {
    // best effort
  }
}

// Brings the SOLVER Chrome's window frontmost on the mini's own console (Aqua) session, so it
// is what the human sees over Screen Sharing — by process id, never `tell application "Google
// Chrome" to activate`, since the mini also runs its own everyday Chrome under that same
// application name. Needs Accessibility permission for System Events to control another app;
// if that's not granted, this just logs and the caller still proceeds (the human can bring the
// window forward themselves over Screen Sharing).
async function findSolverChromePid(): Promise<number | null> {
  try {
    const proc = Bun.spawn(['pgrep', '-f', `remote-debugging-port=${CDP_PORT}`], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const pid = parseInt(out.trim().split('\n')[0] ?? '', 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

async function activateSolverChromeWindow(): Promise<void> {
  const pid = await findSolverChromePid()
  if (pid === null) return
  const script = `
on run argv
  set pidArg to (item 1 of argv) as integer
  tell application "System Events"
    try
      set frontmost of (first process whose unix id is pidArg) to true
    end try
  end tell
end run
`
  try {
    const proc = Bun.spawn(['osascript', '-', String(pid)], { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' })
    proc.stdin.write(script)
    await proc.stdin.end()
    const stderrText = await new Response(proc.stderr).text()
    const code = await proc.exited
    if (code !== 0) logErr('activate_window_failed', { code, stderr: stderrText.slice(0, 500) })
  } catch (err) {
    logErr('activate_window_failed', { error: String(err) })
  }
}

interface EvalResult {
  html: string
  textLen: number
  title: string
  url: string
  /** The settled page's HTTP status, read off the Navigation Timing entry (Chrome >=109) in the
   * same evaluate call — `undefined` on an older Chrome or when the browser never recorded one
   * (a `0` is normalized away here too, since it carries the same "unknown" meaning). */
  status?: number
}

const EVAL_EXPRESSION =
  "JSON.stringify({ html: document.documentElement.outerHTML, textLen: (document.body && document.body.innerText || '').length, title: document.title, url: location.href, status: (function () { try { var e = performance.getEntriesByType('navigation')[0]; return e && e.responseStatus ? e.responseStatus : undefined } catch (err) { return undefined } })() })"

// One WebSocket attach can serve several Runtime.evaluate calls (the DOM-settle check below
// needs two, 1.5s apart) — but NEVER Runtime.enable/Page.enable, and never while the title
// still looks like a challenge: attaching a debugger before the challenge clears is exactly
// what anti-bot scripts fingerprint on.
function openCdpSession(wsUrl: string): { evaluate: () => Promise<EvalResult | null>; close: () => void } {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map<number, (value: EvalResult | null) => void>()
  let ready = false
  const readyPromise = new Promise<void>((resolve) => {
    ws.addEventListener('open', () => {
      ready = true
      resolve()
    })
  })
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(String((ev as MessageEvent).data)) as {
        id?: number
        result?: { result?: { value?: unknown } }
      }
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const resolve = pending.get(msg.id)
        pending.delete(msg.id)
        const value = msg.result?.result?.value
        if (typeof value !== 'string') {
          resolve?.(null)
          return
        }
        try {
          resolve?.(JSON.parse(value) as EvalResult)
        } catch {
          resolve?.(null)
        }
      }
    } catch {
      // ignore unparseable frames
    }
  })
  const failAll = (): void => {
    for (const resolve of pending.values()) resolve(null)
    pending.clear()
  }
  ws.addEventListener('error', failAll)
  ws.addEventListener('close', failAll)

  const evaluate = async (): Promise<EvalResult | null> => {
    if (!ready) await Promise.race([readyPromise, sleep(CDP_CALL_TIMEOUT_MS)])
    if (ws.readyState !== WebSocket.OPEN) return null
    const id = nextId++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(null)
      }, CDP_CALL_TIMEOUT_MS)
      pending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: EVAL_EXPRESSION, returnByValue: true } }))
    })
  }

  return {
    evaluate,
    close: () => {
      try {
        ws.close()
      } catch {
        // best effort
      }
    },
  }
}

let activeTabId: string | undefined

// Extracted so the double-evaluate/stability check (does the page look settled AND unchanged
// across a short gap?) has one home, not inlined in `processRequest`'s poll loop. `deadline` is
// the OVERALL request deadline, not a fresh budget of its own — it only caps the SETTLE_GAP_MS
// wait so this never overshoots the caller's remaining time near the very end of it.
async function readSettledPage(tab: { id: string; wsUrl: string }, deadline: number): Promise<EvalResult | null> {
  const session = openCdpSession(tab.wsUrl)
  try {
    const first = await session.evaluate()
    if (!first || looksChallenged(first.html, first.textLen)) return null
    const gapMs = Math.min(SETTLE_GAP_MS, Math.max(0, deadline - Date.now()))
    await sleep(gapMs)
    const second = await session.evaluate()
    if (!second || looksChallenged(second.html, second.textLen) || second.textLen !== first.textLen) return null
    return second
  } finally {
    session.close()
  }
}

async function processRequest(req: SolverRequest): Promise<SolverOutput> {
  const startedAt = Date.now()
  const overallDeadline = startedAt + req.timeoutMs

  // Refuse to run at all rather than let Chrome browse unfiltered — checked before Chrome is
  // even touched, since a Chrome already up (from an earlier run) tells us nothing about
  // whether THIS run's proxy is currently listening.
  if (!(await isProxyListening(req.proxyPort))) {
    return { ok: false, reason: 'proxy_unavailable' }
  }

  const chromeUp = await ensureChrome(req.proxyPort)
  if (!chromeUp) return { ok: false, reason: 'chrome_unavailable' }

  // Sweep tabs a PRIOR, now-dead run of this script leaked (a hard kill between its own
  // `openTab` and `closeTab`) — only ones old enough that no concurrent run could still
  // legitimately own them. Safe to run for every mode, including 'warm'.
  await sweepOrphanTabs()

  if (req.mode === 'warm') {
    // Launch/verify only — no tab, no page fetch, no human involved. Run before the MacBook
    // dialog so a Chrome/proxy failure short-circuits to a suppression instead of prompting the
    // human for a browser session that was never coming up.
    return { ok: true, mode: 'warm' }
  }

  // Concurrent runs share this one Chrome instance — never sweep/close pre-existing tabs at
  // startup beyond the orphan sweep above, that would kill another run's in-flight tab. Just
  // log how many were already open.
  const preExisting = await listTargets()
  logErr('existing_targets', { count: preExisting.length })

  const tab = await openTab(req.url)
  if (!tab) return { ok: false, reason: 'open_tab_failed' }
  activeTabId = tab.id
  recordTabOpened(tab.id)
  // The 25s cleared-mode challenge clock starts once the tab is actually OPEN, not at request
  // start — `openTab` itself can take real time (Chrome cold-launch contention with a
  // concurrent run), and that time must not eat into the window this chain gets to decide
  // "still challenged, escalate" vs "genuinely slow to load". The OVERALL deadline is
  // unaffected — it still runs from `startedAt`.
  const challengeDeadline = req.mode === 'fetch' ? Date.now() + FETCH_CHALLENGE_ESCALATE_MS : undefined

  try {
    if (req.mode === 'solve') {
      await activateTab(tab.id)
      await activateSolverChromeWindow()
    }

    let stableCount = 0
    while (Date.now() < overallDeadline) {
      if (challengeDeadline !== undefined && Date.now() > challengeDeadline) {
        return { ok: false, reason: 'challenge' }
      }

      const targets = await listTargets()
      const target = targets.find((t) => t.id === tab.id)
      const title = target?.title ?? ''
      if (isChallengeTitle(title, Date.now() - startedAt)) {
        stableCount = 0
        await sleep(STABLE_POLL_MS)
        continue
      }
      stableCount++
      if (stableCount < STABLE_CHECKS_REQUIRED) {
        await sleep(STABLE_POLL_MS)
        continue
      }

      const settled = await readSettledPage(tab, overallDeadline)
      if (!settled) {
        stableCount = 0
        await sleep(STABLE_POLL_MS)
        continue
      }
      // The initial URL was validated in validateRequest, but Chrome follows HTTP/JS/meta
      // redirects on its own — re-validate the SETTLED `location.href` before this html ever
      // leaves the process. Cleared mode needs no human, so this is the only SSRF check that
      // ever runs on a redirect an attacker steered toward a private address.
      const finalUrlCheck = await checkUrlSafety(settled.url)
      if (!finalUrlCheck.ok) {
        logErr('unsafe_redirect', { finalUrl: settled.url, reason: finalUrlCheck.reason })
        return { ok: false, reason: 'unsafe-redirect' }
      }
      return {
        ok: true,
        html: capHtml(settled.html),
        finalUrl: settled.url,
        mode: req.mode === 'solve' ? 'solved' : 'cleared',
        ...(typeof settled.status === 'number' && settled.status > 0 ? { status: settled.status } : {}),
      }
    }
    return { ok: false, reason: 'timeout' }
  } finally {
    await closeTab(tab.id)
    recordTabClosed(tab.id)
    activeTabId = undefined
  }
}

function printResult(result: SolverOutput): void {
  console.log(JSON.stringify(result))
}

function registerSignalHandlers(): void {
  const cleanup = (sig: string): void => {
    logErr('signal', { sig })
    void (async () => {
      if (activeTabId) await closeTab(activeTabId)
      printResult({ ok: false, reason: `signal: ${sig}` })
      process.exit(1)
    })()
  }
  process.on('SIGTERM', () => cleanup('SIGTERM'))
  process.on('SIGHUP', () => cleanup('SIGHUP'))
}

async function main(): Promise<void> {
  registerSignalHandlers()
  const raw = await readStdin()
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (err) {
    printResult({ ok: false, reason: `bad_request: unparseable stdin: ${String(err)}` })
    return
  }
  const validated = await validateRequest(parsedJson)
  if (!validated.ok) {
    printResult({ ok: false, reason: validated.reason })
    return
  }
  const result = await processRequest(validated.value)
  printResult(result)
}

if (import.meta.main) {
  main().catch((err) => {
    logErr('fatal', { error: String(err) })
    printResult({ ok: false, reason: `fatal: ${String(err)}` })
    process.exit(1)
  })
}
