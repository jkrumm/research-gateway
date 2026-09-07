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

export function startMemoryWatch(): void {
  const limitBytes = readCgroupNumber('memory.max')
  if (limitBytes === null || limitBytes === 0) return

  let armed = true
  const timer = setInterval(() => {
    const currentBytes = readCgroupNumber('memory.current')
    if (currentBytes === null) return
    const ratio = currentBytes / limitBytes
    if (armed && ratio >= PRESSURE_RATIO) {
      armed = false
      const events = readCgroupEvents()
      log('process.memory_pressure', {
        currentBytes,
        limitBytes,
        ratio: Number(ratio.toFixed(3)),
        eventsMax: events?.max,
        eventsOom: events?.oom,
      })
      return
    }
    if (!armed && ratio < REARM_RATIO) armed = true
  }, SAMPLE_INTERVAL_MS)
  // Unref'd like every other housekeeping timer here: it must never be what keeps the
  // process alive.
  timer.unref?.()
}
