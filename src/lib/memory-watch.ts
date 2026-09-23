import { readFileSync } from 'node:fs'
import { log } from './log.js'

// The one warning a cgroup OOM kill can leave behind.
//
// 2026-09-04 07:37 UTC: the kernel's memory cgroup OOM killer SIGKILLed the gateway at exactly
// its 1 GiB `mem_limit` (`Memory cgroup out of memory: Killed process … (bun) anon-rss:935864kB`
// in the VPS kernel journal) and the restart reaped 15 jobs. Nothing in the container logged it,
// and nothing could have: SIGKILL runs no handler, so every process-level hook in index.ts is
// silent by construction, and `docker inspect` on the already-restarted container reports
// `ExitCode: 0` / `OOMKilled: false` — the same misleading shape the 2026-07-31 "exit 0" was
// read from. The only in-process signal available is the approach, not the kill: sample the
// cgroup's own accounting against its limit and log once, at error level, when it crosses a
// threshold.
//
// The numerator is `memory.current`, not process RSS: the kernel OOMs on the cgroup's usage
// (anon + file cache + kernel/sock memory), which is what `memory.current` reports, while RSS
// leaves out the cache and kernel share and undercounts the approach. The sample interval is
// short for the same reason — that kill climbed from well under the threshold to the limit
// fast, and a 15 s window fired nothing. `memory.events` rides along on every fire so a
// near-miss (`max` = the high-water mark was hit and reclaim ran) is visible in the log even
// when it did not end in a kill.
//
// cgroup v2 only (`/sys/fs/cgroup/memory.max`, what the VPS runs); unreadable or `max` means
// no limit is known and the watchdog stays inert — local dev and every test run that way.
//
// The mini's native LaunchAgent has no cgroup at all (macOS), so cgroup stays permanently
// unreadable there and the watchdog above would be inert for that instance's whole life. When
// `MEMORY_LIMIT_MB` is set (opt-in — .env.mini.tpl sets it, nothing else does), an
// unreadable cgroup falls back to `process.memoryUsage().rss` against that MiB ceiling instead
// — same thresholds, same log events, same `memorySnapshot()` shape, just a different
// numerator/denominator pair. cgroup stays preferred whenever it IS readable (the VPS), so this
// never changes VPS behaviour. `source: 'cgroup' | 'rss'` on every snapshot and pressure log
// says which one was in play.

const CGROUP_DIR = '/sys/fs/cgroup'
const SAMPLE_INTERVAL_MS = 5_000
const PRESSURE_RATIO = 0.85
const REARM_RATIO = 0.75

function readCgroupNumber(file: string): number | null {
  try {
    const value = Number(readFileSync(`${CGROUP_DIR}/${file}`, 'utf8').trim())
    return Number.isFinite(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

// `memory.events` is `<key> <count>` per line (low, high, max, oom, oom_kill, …); the two that
// describe an approach are `max` (usage hit the limit and reclaim ran) and `oom` (the killer
// was invoked in this cgroup).
function readCgroupEvents(): { max: number; oom: number } | null {
  try {
    const counters = new Map<string, number>()
    for (const line of readFileSync(`${CGROUP_DIR}/memory.events`, 'utf8').split('\n')) {
      const [key, count] = line.trim().split(/\s+/)
      if (key && count !== undefined) counters.set(key, Number(count))
    }
    return { max: counters.get('max') ?? 0, oom: counters.get('oom') ?? 0 }
  } catch {
    return null
  }
}

export interface MemorySnapshot {
  currentBytes: number
  limitBytes: number
  ratio: number
  source: 'cgroup' | 'rss'
}

/** `memory.max`, or null when unreadable/absent/0 (no limit known — off-cgroup or unlimited). */
function cgroupLimitBytes(): number | null {
  const limitBytes = readCgroupNumber('memory.max')
  return limitBytes === null || limitBytes === 0 ? null : limitBytes
}

// Read on demand by `/health` (via `memorySnapshot`) — same cgroup files the watch timer
// samples, exposed as a pure read with no side effect. `fallbackLimitMb` is `MEMORY_LIMIT_MB`
// (env.ts), threaded in by the caller rather than read from env here — this module stays
// env-free. `null` when NEITHER a cgroup limit nor a fallback is available — every local dev
// run and every test run on a machine with no cgroup and no MEMORY_LIMIT_MB set.
export function memorySnapshot(fallbackLimitMb?: number): MemorySnapshot | null {
  const cgroupLimit = cgroupLimitBytes()
  if (cgroupLimit !== null) {
    const currentBytes = readCgroupNumber('memory.current')
    if (currentBytes === null) return null
    return { currentBytes, limitBytes: cgroupLimit, ratio: currentBytes / cgroupLimit, source: 'cgroup' }
  }
  if (fallbackLimitMb === undefined) return null
  const limitBytes = fallbackLimitMb * 1024 * 1024
  const currentBytes = process.memoryUsage().rss
  return { currentBytes, limitBytes, ratio: currentBytes / limitBytes, source: 'rss' }
}

// `onPressureChange` is how the watchdog stops being observability-only and starts shedding
// load: `index.ts` wires it straight to `job-store.ts`'s `setMemoryPressure`, which
// `admission()` reads on every new job. Called exactly on each transition — `true` the
// moment the ratio crosses PRESSURE_RATIO (same place the pressure line already logged),
// `false` when it re-arms below REARM_RATIO. Required, not optional: a watchdog that only
// logs is the exact gap the 2026-09-04 OOM kill exposed (all 3 concurrent jobs died with the
// process because nothing upstream ever stopped admitting more).
/**
 * `fallbackLimitMb` is `MEMORY_LIMIT_MB` (env.ts), threaded in by `index.ts` rather than read
 * from env here — same reasoning as `memorySnapshot`. Only consulted when the cgroup limit is
 * unreadable; cgroup wins whenever it's available, so this never changes VPS behaviour.
 */
export function startMemoryWatch(
  onPressureChange: (under: boolean) => void,
  fallbackLimitMb?: number,
): void {
  const cgroupLimit = cgroupLimitBytes()
  const source: 'cgroup' | 'rss' = cgroupLimit !== null ? 'cgroup' : 'rss'
  const limitBytes = cgroupLimit ?? (fallbackLimitMb !== undefined ? fallbackLimitMb * 1024 * 1024 : null)
  if (limitBytes === null) return

  let armed = true
  const timer = setInterval(() => {
    const currentBytes = source === 'cgroup' ? readCgroupNumber('memory.current') : process.memoryUsage().rss
    if (currentBytes === null) return
    const ratio = currentBytes / limitBytes
    if (armed && ratio >= PRESSURE_RATIO) {
      armed = false
      const events = source === 'cgroup' ? readCgroupEvents() : null
      log('process.memory_pressure', {
        currentBytes,
        limitBytes,
        ratio: Number(ratio.toFixed(3)),
        source,
        eventsMax: events?.max,
        eventsOom: events?.oom,
      })
      onPressureChange(true)
      return
    }
    if (!armed && ratio < REARM_RATIO) {
      armed = true
      // Invisible today without this: the pressure line above is unreadable in isolation —
      // it says load was shed, never says when it stopped being necessary.
      log('process.memory_recovered', { currentBytes, limitBytes, ratio: Number(ratio.toFixed(3)), source })
      onPressureChange(false)
    }
  }, SAMPLE_INTERVAL_MS)
  // Unref'd like every other housekeeping timer here: it must never be what keeps the
  // process alive.
  timer.unref?.()
}
