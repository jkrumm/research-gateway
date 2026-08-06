// yt-dlp client — the two YouTube code paths (transcript fetch, video search) that used to be
// Tavily Extract and an HTML-scrape of the search page. Both now spawn the pinned binary
// bundled into the image (see the Dockerfile) instead.
//
// MEASURED 2026-08-06 from the VPS, `yt-dlp_musllinux` v2026.07.04 inside `oven/bun:1.3-alpine`
// (the exact runtime image): one `-J` extraction + one direct GET of the caption URL —
//   `8aGhZQkoFbQ` (manual `en`)  — extract 3,989ms + fetch  182ms = 4,171ms, 22,147 chars
//   `ELYfRiF-424` (auto `de`)    — extract 3,427ms + fetch  198ms = 3,625ms, 80,411 chars
//   `-PHXi7NTB8k` (manual `en`)  — extract 3,837ms + fetch   93ms = 3,930ms, 19,967 chars
// The caption URLs returned inside `-J` work when fetched directly with a plain GET — the
// `baseUrl` scraped straight from the watch page instead returns HTTP 200 with ZERO bytes
// (PO-token gated); yt-dlp's URLs carry the params that make them work. `-PHXi7NTB8k` is a
// video Tavily Extract failed on in production, and yt-dlp read it fine.
//
// Two flag traps, both measured, and load-bearing for the flags below:
//   - `--extractor-args "youtube:player_skip=webpage,configs"` triggers
//     `ERROR: Sign in to confirm you're not a bot` on EVERY video. Never add it.
//   - `--sub-langs "en.*"` is a glob that expands to ~157 auto-translated tracks and causes
//     `HTTP Error 429: Too Many Requests`. Even two exact codes (`en,de`) download a useless
//     machine-translated track (300,905 bytes of German for an English tutorial). This is
//     exactly why this module picks ONE track itself from `-J`'s metadata instead of using
//     `--write-subs` at all.
//
// Contract shared with every tool in this file's callers (fetch-chain.ts, direct-sources.ts):
// NEVER throw. An uncaught throw here kills the worker that called it and loses every digest
// that worker had gathered — the same contract runFetchChain and every tool builder follows.

import { env } from '../env.js'
import { log } from '../lib/log.js'
import { createSemaphore } from '../lib/semaphore.js'
import { assertPublicHttpUrl } from '../lib/ssrf.js'
import { pickCaptionTrack, parseJson3, buildTranscriptText, type YtdlpInfo } from './youtube-captions.js'

// YouTube rate-limits this datacenter IP under burst (see the module header above) —
// bounded on purpose, shared by both functions below since both spawn the same binary
// against the same origin.
const slots = createSemaphore(env.YTDLP_MAX_CONCURRENCY, env.YTDLP_TIMEOUT_MS)

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

// Bounds how much of a spawned process's stdout/stderr this reads into memory. `-J` on a
// single video was measured at 642 KB; this cap is far above that so it never trips on a
// real video and only guards against a pathological response (a huge search result set, a
// binary gone wrong).
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

async function readCapped(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<string> {
  if (!stream) return ''
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > cap) break
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

function firstErrorLine(stderr: string): string {
  const line = stderr.split('\n').find((l) => l.trim().length > 0)
  return line?.trim() ?? 'yt-dlp failed with no stderr output'
}

interface SpawnResult {
  ok: boolean
  stdout: string
  error?: string
}

// Shared by fetchYoutubeTranscript and searchYoutube — same binary, same timeout/kill
// contract, same "capture both streams, never throw" shape. Distinct from lightpanda's own
// spawn wrapper (lightpanda/server.ts): that is a separate build across a container
// boundary this module does not cross.
async function runYtdlp(args: string[], jobId: string): Promise<SpawnResult> {
  try {
    const proc = Bun.spawn([env.YTDLP_PATH, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: env.YTDLP_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })

    const [stdout, stderr] = await Promise.all([
      readCapped(proc.stdout, MAX_OUTPUT_BYTES),
      readCapped(proc.stderr, MAX_OUTPUT_BYTES),
    ])
    const code = await proc.exited

    // `proc.signalCode` is the discriminator for "the deadline fired", not `proc.killed` —
    // measured true on Bun 1.3 for both a SIGKILL and a clean fast exit alike (the same trap
    // documented in lightpanda/server.ts). signalCode is null on any exit the process chose
    // for itself and 'SIGKILL' only when the timeout above fired.
    if (proc.signalCode) {
      return { ok: false, stdout: '', error: `yt-dlp timed out after ${env.YTDLP_TIMEOUT_MS}ms` }
    }
    if (code !== 0) {
      return { ok: false, stdout: '', error: firstErrorLine(stderr) }
    }
    return { ok: true, stdout }
  } catch (err) {
    return { ok: false, stdout: '', error: String(err) }
  }
}

export interface TranscriptResult {
  text: string
  title: string | null
  chars: number
  source: 'manual' | 'auto'
  lang: string
}

export async function fetchYoutubeTranscript(
  watchUrl: string,
  opts?: { jobId?: string },
): Promise<TranscriptResult | null> {
  const jobId = opts?.jobId ?? '-'
  const extractStart = performance.now()

  const gotSlot = await slots.acquire()
  if (!gotSlot) {
    log('tool.ytdlp', { jobId, url: watchUrl, ok: false, error: 'concurrency queue timeout' })
    return null
  }

  try {
    const spawned = await runYtdlp(
      ['-J', '--skip-download', '--no-playlist', '--no-warnings', '--ignore-config', '--socket-timeout', '15', watchUrl],
      jobId,
    )
    const extractMs = Math.round(performance.now() - extractStart)
    if (!spawned.ok) {
      log('tool.ytdlp', { jobId, url: watchUrl, ok: false, error: spawned.error, extractMs })
      return null
    }

    let info: YtdlpInfo
    try {
      info = JSON.parse(spawned.stdout) as YtdlpInfo
    } catch (err) {
      log('tool.ytdlp', { jobId, url: watchUrl, ok: false, error: `unparseable -J output: ${String(err)}`, extractMs })
      return null
    }

    const track = pickCaptionTrack(info)
    if (!track) {
      log('tool.ytdlp', { jobId, url: watchUrl, ok: false, error: 'no json3 caption track', extractMs })
      return null
    }

    const fetchStart = performance.now()
    let body: string
    try {
      // Same SSRF posture as every other fetch in this service (fetch-chain.ts's
      // safeFetch) — the URL comes out of yt-dlp's own metadata rather than a model, but
      // defense in depth costs nothing here.
      await assertPublicHttpUrl(track.url)
      const res = await fetch(track.url, {
        headers: { 'user-agent': BROWSER_UA },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) {
        log('tool.ytdlp', { jobId, url: watchUrl, ok: false, error: `caption fetch HTTP ${res.status}`, extractMs })
        return null
      }
      body = await res.text()
    } catch (err) {
      log('tool.ytdlp', { jobId, url: watchUrl, ok: false, error: `caption fetch failed: ${String(err)}`, extractMs })
      return null
    }
    const fetchMs = Math.round(performance.now() - fetchStart)

    const transcript = parseJson3(body)
    if (transcript.length === 0) {
      log('tool.ytdlp', { jobId, url: watchUrl, ok: false, error: 'empty transcript after parseJson3', extractMs, fetchMs })
      return null
    }

    const title = info.title ?? null
    const text = buildTranscriptText({
      title,
      uploader: info.uploader ?? info.channel ?? null,
      durationSec: info.duration ?? null,
      lang: track.code,
      source: track.source,
      transcript,
    })

    log('tool.ytdlp', {
      jobId,
      url: watchUrl,
      ok: true,
      source: track.source,
      lang: track.code,
      chars: text.length,
      extractMs,
      fetchMs,
    })

    return { text, title, chars: text.length, source: track.source, lang: track.code }
  } catch (err) {
    log('tool.ytdlp', { jobId, url: watchUrl, ok: false, error: String(err) })
    return null
  } finally {
    slots.release()
  }
}

export interface YoutubeSearchHit {
  videoId: string
  title: string
  channel: string | null
  durationSeconds: number | null
  viewsText: string | null
  url: string
}

interface YtdlpFlatEntry {
  id?: string
  title?: string
  channel?: string | null
  duration?: number | null
  view_count?: number | null
}

interface YtdlpFlatPlaylist {
  entries?: YtdlpFlatEntry[]
}

export async function searchYoutube(
  query: string,
  limit: number,
  opts?: { jobId?: string },
): Promise<YoutubeSearchHit[] | null> {
  const jobId = opts?.jobId ?? '-'
  const started = performance.now()

  const gotSlot = await slots.acquire()
  if (!gotSlot) {
    log('tool.ytdlp', { jobId, query, ok: false, error: 'concurrency queue timeout' })
    return null
  }

  try {
    const spawned = await runYtdlp(
      ['--flat-playlist', '-J', '--no-warnings', '--ignore-config', '--socket-timeout', '15', `ytsearch${limit}:${query}`],
      jobId,
    )
    const ms = Math.round(performance.now() - started)
    if (!spawned.ok) {
      log('tool.ytdlp', { jobId, query, ok: false, error: spawned.error, ms })
      return null
    }

    let data: YtdlpFlatPlaylist
    try {
      data = JSON.parse(spawned.stdout) as YtdlpFlatPlaylist
    } catch (err) {
      log('tool.ytdlp', { jobId, query, ok: false, error: `unparseable -J output: ${String(err)}`, ms })
      return null
    }

    const results: YoutubeSearchHit[] = []
    for (const entry of data.entries ?? []) {
      if (!entry.id) continue
      results.push({
        videoId: entry.id,
        title: entry.title ?? '',
        channel: entry.channel ?? null,
        durationSeconds: typeof entry.duration === 'number' ? entry.duration : null,
        viewsText: typeof entry.view_count === 'number' ? `${entry.view_count.toLocaleString('en-US')} views` : null,
        // The canonical watch-URL shape — this is the ledger key a citation is checked
        // against (ledger.ts / site-adapters.ts), so it must match exactly what
        // canonicalYoutubeWatchUrl produces for the same id.
        url: `https://www.youtube.com/watch?v=${entry.id}`,
      })
    }

    log('tool.ytdlp', { jobId, query, ok: true, results: results.length, ms })
    return results
  } catch (err) {
    log('tool.ytdlp', { jobId, query, ok: false, error: String(err) })
    return null
  } finally {
    slots.release()
  }
}
