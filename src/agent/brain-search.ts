// Spawn+fs wrapper for the `brainNotes` tool — ripgrep does candidate discovery, this module
// enforces the scope boundary (realpath under `${BRAIN_DIR}/wiki/`, no dotfiles/dirs, no
// symlink escape) and reads the winning files. Ranking/excerpting itself is pure (brain.ts),
// kept env/fs-free the same way pdf-extract.ts/youtube-captions.ts are relative to
// pdf.ts/ytdlp.ts.
//
// Contract shared with every tool builder in this file's callers (tools.ts): NEVER throw — an
// uncaught throw kills the worker that called it and loses every digest it had gathered.

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { env } from '../env.js'
import { log } from '../lib/log.js'
import { readCappedText } from './bounded-read.js'
import { rankAndBuildNotes, parseQueryTerms, buildCorpusStats } from './brain.js'
import type { BrainCandidate, BrainNoteResult, CorpusStats } from './brain.js'

// A hang guard, not a tuning default — ripgrep over a few hundred small markdown files should
// resolve in well under a second; this only bounds a pathological case (a vault grown huge, a
// wedged process). Shared by both the per-query search and the whole-corpus file listing below.
const RG_TIMEOUT_MS = 10_000
const MAX_RG_OUTPUT_BYTES = 4 * 1024 * 1024
// Guards a symlink resolving to something enormous outside the vault's normal note size —
// defense in depth on TOP of the realpath scope check, not a substitute for it.
const MAX_NOTE_BYTES = 2 * 1024 * 1024

export type BrainSearchResult =
  | { ok: true; notes: BrainNoteResult[] }
  | { ok: false; error: string }

type RgResult = { ok: true; paths: string[] } | { ok: false; paths: []; error: string }

/** Reads a ripgrep stdout stream the same way pdf-extract.ts's readCappedText does — stop
 * appending to the returned text once `capBytes` is exceeded — but, unlike that helper, keeps
 * draining the rest of the stream afterward counting ONLY newline bytes (not decoding or
 * storing them), so a truncation log can report how many path lines were actually dropped
 * without defeating the cap's own point (bounding memory on a pathological, huge-output case). */
async function readCappedRgStdout(
  stream: ReadableStream<Uint8Array> | null,
  capBytes: number,
): Promise<{ text: string; truncated: boolean; totalLines: number }> {
  if (!stream) return { text: '', truncated: false, totalLines: 0 }
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let truncated = false
  let totalLines = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    for (const byte of chunk) if (byte === 0x0a) totalLines++
    if (bytes <= capBytes) {
      text += decoder.decode(chunk, { stream: true })
    } else {
      truncated = true
    }
  }
  if (!truncated) text += decoder.decode()
  return { text, truncated, totalLines }
}

/** Spawns ripgrep with `args`, maps timeout/exit-code/spawn-failure/output-truncation into a
 * uniform result, and logs every failure mode as `tool.brainNotes` with `ok: false` — `context`
 * ("search" vs "corpus listing") tags which caller it was, since both share this helper.
 * `--no-config` is load-bearing: without it a stray user-level ripgrep config (e.g. a personal
 * `.rgignore`/`ignore-case` default) could silently change what this tool sees, which would be
 * an invisible, unlogged behavior change on whatever machine happens to run it. */
async function spawnRg(args: string[], jobId: string, context: string): Promise<RgResult> {
  try {
    const proc = Bun.spawn([env.RG_PATH, '--no-config', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: RG_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    const [stdoutRes, stderrText] = await Promise.all([
      readCappedRgStdout(proc.stdout, MAX_RG_OUTPUT_BYTES),
      readCappedText(proc.stderr, MAX_RG_OUTPUT_BYTES),
    ])
    const code = await proc.exited

    // `proc.signalCode`, not `proc.killed` — the same Bun trap documented in ytdlp.ts's
    // runYtdlp: measured true on both a SIGKILL and a clean fast exit alike. signalCode is
    // null on any exit the process chose for itself and 'SIGKILL' only when the timeout fired.
    if (proc.signalCode) {
      const error = `ripgrep (${context}) timed out after ${RG_TIMEOUT_MS}ms`
      log('tool.brainNotes', { jobId, ok: false, error })
      return { ok: false, paths: [], error }
    }
    // rg's exit code convention: 0 = matches found, 1 = no matches (not an error), 2 = a real
    // error (bad glob, missing binary behaviour, etc.).
    if (code === 1) return { ok: true, paths: [] }
    if (code !== 0) {
      const reason = stderrText.split('\n').find((l) => l.trim().length > 0)?.trim() ?? `ripgrep (${context}) exited ${code}`
      log('tool.brainNotes', { jobId, ok: false, error: reason })
      return { ok: false, paths: [], error: reason }
    }

    const paths = stdoutRes.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    if (stdoutRes.truncated) {
      // totalLines counts every newline byte seen, including the ones inside the discarded
      // tail — paths.length only reflects the lines that survived under the cap, so the gap
      // between them is exactly how many path lines were dropped.
      const dropped = Math.max(0, stdoutRes.totalLines - paths.length)
      log('tool.brainNotes', {
        jobId,
        ok: false,
        error: `ripgrep (${context}) output exceeded ${MAX_RG_OUTPUT_BYTES} bytes — ~${dropped} path(s) dropped`,
      })
    }
    return { ok: true, paths }
  } catch (err) {
    const error = `ripgrep (${context}) spawn failed: ${String(err)}`
    log('tool.brainNotes', { jobId, ok: false, error })
    return { ok: false, paths: [], error }
  }
}

async function runRg(terms: string[], wikiDirReal: string, jobId: string): Promise<RgResult> {
  const args = ['--files-with-matches', '--ignore-case', '--fixed-strings', '--glob', '*.md']
  for (const term of terms) args.push('-e', term)
  args.push(wikiDirReal)
  return spawnRg(args, jobId, 'search')
}

/** Lists every in-scope .md path under the wiki root — the candidate pool buildCorpusStats
 * tokenizes into whole-vault df numbers, see getCorpusStats below. */
async function listAllWikiFiles(wikiDirReal: string, jobId: string): Promise<RgResult> {
  return spawnRg(['--files', '--glob', '*.md', wikiDirReal], jobId, 'corpus listing')
}

/** True when every path segment of `relPath` is a plain name — no dotfile, no dotdir, no empty
 * segment. Applied to the path already resolved relative to the wiki root, so this also catches
 * a symlink target that resolves BACK into a dotdir even if the original candidate's own path
 * did not mention one. */
function hasDotSegment(relPath: string): boolean {
  return relPath.split('/').some((seg) => seg.length === 0 || seg.startsWith('.'))
}

/**
 * Resolves each candidate path to its realpath and keeps only the ones that land under
 * `wikiDirReal` with no dotfile/dotdir segment — the hard scope boundary from the module header.
 * A note whose target escapes (symlink pointing outside the wiki tree — a real case in this
 * vault: `wiki/engineering/dotfiles-architecture.md` -> `../../../dotfiles/docs/architecture.md`,
 * which resolves OUTSIDE `${BRAIN_DIR}/wiki` entirely) is silently dropped, not reported as an
 * error — from the caller's perspective it simply did not match.
 */
async function readScopedCandidates(
  paths: string[],
  brainDirReal: string,
  wikiDirReal: string,
): Promise<BrainCandidate[]> {
  const candidates: BrainCandidate[] = []
  for (const p of paths) {
    let real: string
    try {
      real = await realpath(p)
    } catch {
      continue
    }
    const relToWiki = relative(wikiDirReal, real)
    if (relToWiki.startsWith('..') || isAbsolute(relToWiki) || hasDotSegment(relToWiki)) continue

    const info = await stat(real).catch(() => null)
    if (!info || !info.isFile() || info.size > MAX_NOTE_BYTES) continue

    const content = await readFile(real, 'utf-8').catch(() => null)
    if (content === null) continue

    // relPath is BRAIN_DIR-relative (carries the "wiki/" prefix), not wiki-relative — this is
    // what the vault reader's own slug is built from (brain.ts's buildNoteUrl doc comment).
    candidates.push({ relPath: relative(brainDirReal, real), content })
  }
  return candidates
}

// Cached in-process, not per-request: the vault syncs to the mini every 5 minutes, so rebuilding
// the whole-corpus df table (buildCorpusStats over ~203 notes, ~1.9 MB) on every single
// brainNotes call would be repeated work the vault's own update cadence never asks for. Keyed on
// wikiDirReal so a config change mid-process (not expected, but env.ts is read once at boot
// either way) can't serve a stale corpus for the wrong path.
const CORPUS_CACHE_TTL_MS = 5 * 60 * 1000
let corpusCache: { stats: CorpusStats; wikiDirReal: string; builtAt: number } | null = null

/** Returns the cached whole-corpus stats, rebuilding them (list + read + tokenize every in-scope
 * note) when the cache is missing, stale, or was built for a different wiki root. On a listing
 * failure (timeout/spawn/rg error — already logged by spawnRg), degrades to treating `candidates`
 * (this call's own search results) as the corpus rather than returning an empty one — worse than
 * a real whole-vault corpus, but strictly better than idf=0-for-everything, and matches this
 * module's "never throw, degrade gracefully" contract. That fallback is NOT cached — the next
 * call retries the real listing. */
async function getCorpusStats(args: {
  brainDirReal: string
  wikiDirReal: string
  jobId: string
  fallbackCandidates: BrainCandidate[]
}): Promise<CorpusStats> {
  const { brainDirReal, wikiDirReal, jobId, fallbackCandidates } = args
  const now = Date.now()
  if (corpusCache && corpusCache.wikiDirReal === wikiDirReal && now - corpusCache.builtAt < CORPUS_CACHE_TTL_MS) {
    return corpusCache.stats
  }

  const listing = await listAllWikiFiles(wikiDirReal, jobId)
  if (!listing.ok) {
    return buildCorpusStats(fallbackCandidates)
  }

  const notes = await readScopedCandidates(listing.paths, brainDirReal, wikiDirReal)
  const stats = buildCorpusStats(notes)
  corpusCache = { stats, wikiDirReal, builtAt: now }
  return stats
}

export async function searchBrain(query: string, jobId = '-'): Promise<BrainSearchResult> {
  if (!env.BRAIN_DIR || !env.BRAIN_BASE_URL) {
    return { ok: false, error: 'brainNotes is not configured on this host' }
  }

  const terms = parseQueryTerms(query)
  if (terms.length === 0) {
    return { ok: false, error: 'query too short — use at least one word of 3+ characters' }
  }

  let brainDirReal: string
  let wikiDirReal: string
  try {
    brainDirReal = await realpath(env.BRAIN_DIR)
    wikiDirReal = await realpath(join(brainDirReal, 'wiki'))
  } catch (err) {
    log('tool.brainNotes', { jobId, ok: false, error: `BRAIN_DIR/wiki unreadable: ${String(err)}` })
    return { ok: false, error: 'brain vault is unreadable on this host' }
  }

  const rg = await runRg(terms, wikiDirReal, jobId)
  if (!rg.ok) {
    return { ok: false, error: `brainNotes search failed: ${rg.error ?? 'unknown error'}` }
  }
  if (rg.paths.length === 0) {
    log('tool.brainNotes', { jobId, query, terms, strong: 0, ok: true })
    return { ok: true, notes: [] }
  }

  const candidates = await readScopedCandidates(rg.paths, brainDirReal, wikiDirReal)
  const corpus = await getCorpusStats({ brainDirReal, wikiDirReal, jobId, fallbackCandidates: candidates })
  // `notes` is now ONLY strong matches (rankAndBuildNotes drops everything else) — `strong`,
  // not `results`, is the honest field name for what this count means.
  const notes = rankAndBuildNotes({ candidates, terms, baseUrl: env.BRAIN_BASE_URL, corpus })
  log('tool.brainNotes', {
    jobId,
    query,
    terms,
    candidates: candidates.length,
    corpusSize: corpus.size,
    strong: notes.length,
    ok: true,
  })
  return { ok: true, notes }
}
