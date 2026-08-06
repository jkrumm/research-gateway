// Pure yt-dlp caption-track shape logic — picking the right track out of a `-J` extraction,
// and turning its `json3` body into plain text.
//
// Dependency-free by design (no env/fetch/spawn import) so this stays unit-testable without
// booting the env-parsing chain or spawning a process — same convention as ledger.ts /
// extract.ts / site-adapters.ts. Everything that actually runs yt-dlp lives in ytdlp.ts.

export interface CaptionFormat {
  ext?: string
  url?: string
}

export interface YtdlpInfo {
  language?: string | null
  title?: string | null
  uploader?: string | null
  channel?: string | null
  duration?: number | null
  subtitles?: Record<string, CaptionFormat[]> | null
  automatic_captions?: Record<string, CaptionFormat[]> | null
}

export interface PickedTrack {
  source: 'manual' | 'auto'
  code: string
  url: string
}

// `<lang>`, `<lang>-orig` and `<lang>-<lang>` are the three shapes yt-dlp has been observed
// to key a video's own-language track under — which one a given upload gets is not
// documented anywhere authoritative, so all three are tried rather than guessed.
function codesFor(lang: string): string[] {
  return [lang, `${lang}-orig`, `${lang}-${lang}`]
}

// Only `json3` carries per-segment timing text this module can join into prose; other
// formats (vtt, srv1/2/3, ttml) are declined rather than parsed.
function findJson3Url(table: Record<string, CaptionFormat[]> | null | undefined, code: string): string | null {
  const formats = table?.[code]
  if (!formats) return null
  const hit = formats.find((f) => f.ext === 'json3' && typeof f.url === 'string' && f.url.length > 0)
  return hit?.url ?? null
}

// Manual outranks auto — not a style preference, a measured quality gap. MEASURED (same
// moment in the same video): manual — "- Today, we are finally gonna bring everyone out
// there up to speed on how to use a flash." — carries punctuation and sentence breaks; auto
// — "today we are finally going to bring everyone out there up to speed on how to use a
// flash" — is a flat, unpunctuated machine transcription of the same words. A worker quoting
// auto captions is quoting a machine's best guess at where a sentence ends.
//
// Order: the video's own language (manual, then auto) first; only once that whole language
// has nothing does this fall back to English (manual, then auto) — the fallback exists for
// the case where a video simply has no track in its own language, not as a first choice.
// Never throws — every branch is a lookup into optional data, and a caller with a malformed
// or absent table should get `null`, not an exception mid-worker.
export function pickCaptionTrack(info: YtdlpInfo): PickedTrack | null {
  try {
    const lang = (info.language ?? 'en').split('-')[0] || 'en'
    const codes = codesFor(lang)

    for (const code of codes) {
      const url = findJson3Url(info.subtitles, code)
      if (url) return { source: 'manual', code, url }
    }
    for (const code of codes) {
      const url = findJson3Url(info.automatic_captions, code)
      if (url) return { source: 'auto', code, url }
    }

    if (lang !== 'en') {
      const manualEn = findJson3Url(info.subtitles, 'en')
      if (manualEn) return { source: 'manual', code: 'en', url: manualEn }
      const autoEn = findJson3Url(info.automatic_captions, 'en')
      if (autoEn) return { source: 'auto', code: 'en', url: autoEn }
    }

    return null
  } catch {
    return null
  }
}

// `json3`'s shape: `{ events: [{ segs: [{ utf8: "..." }, ...] }, ...] }`. Whitespace runs
// (json3 pads with standalone "\n" segs between cues) collapse to a single space so the
// output reads as prose rather than a caption file. Never throws — malformed input returns
// the empty string, which the caller (ytdlp.ts) treats as a miss like any other.
export function parseJson3(body: string): string {
  try {
    const data = JSON.parse(body) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> }
    if (!data || !Array.isArray(data.events)) return ''

    const parts: string[] = []
    for (const event of data.events) {
      if (!event || !Array.isArray(event.segs)) continue
      for (const seg of event.segs) {
        if (seg == null || typeof seg.utf8 !== 'string') continue
        parts.push(seg.utf8)
      }
    }
    return parts.join('').replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

// Self-describing so a worker reading this text knows what it is looking at without a
// separate tool response — title, then a metadata line, then the transcript. Whether the
// captions are auto-generated is stated explicitly in that line, not just carried in a
// structured field: it directly bears on how much a quote from this text can be trusted
// (see the punctuation comparison on pickCaptionTrack above), and prose in the transcript
// body is the one place a synthesizing model reliably reads it.
export function buildTranscriptText(args: {
  title: string | null
  uploader: string | null
  durationSec: number | null
  lang: string
  source: 'manual' | 'auto'
  transcript: string
}): string {
  const { title, uploader, durationSec, lang, source, transcript } = args
  const heading = `# ${title ?? 'Untitled video'}`
  const durationText = durationSec != null ? formatDuration(durationSec) : 'unknown'
  const captionsText =
    source === 'manual'
      ? `manual captions (${lang})`
      : `AUTO-GENERATED captions (${lang}) — machine transcription, unpunctuated; treat quotes as approximate`
  const meta = `Channel: ${uploader ?? 'unknown'} · Duration: ${durationText} · Captions: ${captionsText}`
  return `${heading}\n\n${meta}\n\n${transcript}`
}
