// Spawn+fs wrapper for the `brainNotes` tool — ripgrep does candidate discovery, this module
// enforces the scope boundary (realpath under one of the vault roots, no dotfiles/dirs, no
// symlink escape, no journal) and reads the winning files. Ranking/excerpting itself is pure
// (brain.ts), kept env/fs-free the same way pdf-extract.ts/youtube-captions.ts are relative to
// pdf.ts/ytdlp.ts.
//
// Contract shared with every tool builder in this file's callers (tools.ts): NEVER throw — an
// uncaught throw kills the worker that called it and loses every digest it had gathered.

import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { env } from '../env.js'
import { log } from '../lib/log.js'
import { readCappedText } from './pdf-extract.js'
import {
  rankAndBuildNotes,
  parseQueryTerms,
  buildCorpusStats,
  isJournalPath,
  isJournalNote,
  parseNoteRef,
  pickNoteByRef,
  buildFullNote,
} from './brain.js'
import type { BrainCandidate, BrainNoteFull, BrainNoteResult, CorpusStats } from './brain.js'

// The vault trees brainNotes may read. Owner decision 2026-09-25: wiki, projects, areas and
// inbox are in scope (health and finance notes included); journals never. Anything else under
// BRAIN_DIR — vault-root files (log.md, voice.md, index.md, AGENTS.md), docs/, dot-dirs — is
// not a root, so it is never searched, listed or read. A root that does not exist (Inbox/ may
// be absent) is simply skipped.
const BRAIN_ROOTS = ['wiki', 'Projects', 'Areas', 'Inbox'] as const

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

async function runRg(terms: string[], rootReals: readonly string[], jobId: string): Promise<RgResult> {
  const args = ['--files-with-matches', '--ignore-case', '--fixed-strings', '--glob', '*.md']
  for (const term of terms) args.push('-e', term)
  args.push(...rootReals)
  return spawnRg(args, jobId, 'search')
}

/** Lists every in-scope .md path under the roots — the candidate pool buildCorpusStats
 * tokenizes into whole-vault df numbers, see getCorpusStats below. */
async function listAllFiles(rootReals: readonly string[], jobId: string): Promise<RgResult> {
  if (rootReals.length === 0) return { ok: true, paths: [] }
  return spawnRg(['--files', '--glob', '*.md', ...rootReals], jobId, 'corpus listing')
}

/** True when every path segment is a plain name — no dotfile, no dotdir, no empty segment.
 * Applied to the path already resolved relative to a root, so this also catches a symlink
 * target that resolves BACK into a dotdir even if the original candidate's own path did not
 * mention one. */
function hasDotSegment(relPath: string): boolean {
  return relPath.split('/').some((seg) => seg.length === 0 || seg.startsWith('.'))
}

/** Resolves each configured vault root to its realpath, skipping any that do not exist (a
 * missing Inbox/ is normal). Returns [] when none of them is readable. */
async function resolveRoots(brainDirReal: string): Promise<string[]> {
  const roots: string[] = []
  for (const name of BRAIN_ROOTS) {
    try {
      roots.push(await realpath(join(brainDirReal, name)))
    } catch {
      // Out of scope, not an error — this root is simply absent.
    }
  }
  return roots
}

/**
 * Resolves each candidate path to its realpath and keeps only the ones that land under ONE of
 * `rootReals` with no dotfile/dotdir segment and without a journal path — the hard scope
 * boundary from the module header. A note whose target escapes (symlink pointing outside every
 * root — a real case in this vault: `wiki/engineering/dotfiles-architecture.md` ->
 * `../../../dotfiles/docs/architecture.md`, which resolves OUTSIDE `${BRAIN_DIR}` entirely) is
 * silently dropped, not reported as an error — from the caller's perspective it simply did not
 * match.
 */
async function readScopedCandidates(
  paths: string[],
  brainDirReal: string,
  rootReals: readonly string[],
): Promise<BrainCandidate[]> {
  const candidates: BrainCandidate[] = []
  for (const p of paths) {
    let real: string
    try {
      real = await realpath(p)
    } catch {
      continue
    }

    const underRoot = rootReals.some((root) => {
      const rel = relative(root, real)
      return !rel.startsWith('..') && !isAbsolute(rel) && !hasDotSegment(rel)
    })
    if (!underRoot) continue

    // relPath is BRAIN_DIR-relative (carries the "wiki/"/"Projects/"/"Areas/"/"Inbox/" prefix),
    // not root-relative — this is what the vault reader's own slug is built from (brain.ts's
    // buildNoteUrl doc comment). Journal filtering is path-only here so it can also run over the
    // whole corpus listing; the frontmatter rules live in rankAndBuildNotes.
    const relPath = relative(brainDirReal, real)
    if (isJournalPath(relPath)) continue

    const info = await stat(real).catch(() => null)
    if (!info || !info.isFile() || info.size > MAX_NOTE_BYTES) continue

    const content = await readFile(real, 'utf-8').catch(() => null)
    if (content === null) continue

    candidates.push({ relPath, content })
  }
  return candidates
}

// Cached in-process, not per-request: the vault syncs to the mini every 5 minutes, so rebuilding
// the whole-corpus df table (buildCorpusStats over every in-scope note across all roots) on every
// single brainNotes call would be repeated work the vault's own update cadence never asks for.
// Keyed on the resolved roots so a config change mid-process (not expected, but env.ts is read
// once at boot either way) can't serve a stale corpus for the wrong path.
const CORPUS_CACHE_TTL_MS = 5 * 60 * 1000
let corpusCache: { stats: CorpusStats; rootsKey: string; builtAt: number } | null = null

/** Returns the cached whole-corpus stats, rebuilding them (list + read + tokenize every in-scope
 * note across all roots) when the cache is missing, stale, or was built for a different root
 * set. On a listing failure (timeout/spawn/rg error — already logged by spawnRg), degrades to
 * treating `candidates` (this call's own search results) as the corpus rather than returning an
 * empty one — worse than a real whole-vault corpus, but strictly better than
 * idf=0-for-everything, and matches this module's "never throw, degrade gracefully" contract.
 * That fallback is NOT cached — the next call retries the real listing. */
async function getCorpusStats(args: {
  brainDirReal: string
  rootReals: readonly string[]
  jobId: string
  fallbackCandidates: BrainCandidate[]
}): Promise<CorpusStats> {
  const { brainDirReal, rootReals, jobId, fallbackCandidates } = args
  const rootsKey = rootReals.join('\u0000')
  const now = Date.now()
  if (corpusCache && corpusCache.rootsKey === rootsKey && now - corpusCache.builtAt < CORPUS_CACHE_TTL_MS) {
    return corpusCache.stats
  }

  const listing = await listAllFiles(rootReals, jobId)
  if (!listing.ok) {
    return buildCorpusStats(fallbackCandidates)
  }

  const notes = await readScopedCandidates(listing.paths, brainDirReal, rootReals)
  const stats = buildCorpusStats(notes)
  corpusCache = { stats, rootsKey, builtAt: now }
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
  try {
    brainDirReal = await realpath(env.BRAIN_DIR)
  } catch (err) {
    log('tool.brainNotes', { jobId, ok: false, error: `BRAIN_DIR unreadable: ${String(err)}` })
    return { ok: false, error: 'brain vault is unreadable on this host' }
  }

  const rootReals = await resolveRoots(brainDirReal)
  if (rootReals.length === 0) {
    log('tool.brainNotes', { jobId, ok: false, error: 'no readable vault roots' })
    return { ok: false, error: 'brain vault has no readable roots on this host' }
  }

  const rg = await runRg(terms, rootReals, jobId)
  if (!rg.ok) {
    return { ok: false, error: `brainNotes search failed: ${rg.error ?? 'unknown error'}` }
  }
  if (rg.paths.length === 0) {
    log('tool.brainNotes', { jobId, query, terms, strong: 0, ok: true })
    return { ok: true, notes: [] }
  }

  const candidates = await readScopedCandidates(rg.paths, brainDirReal, rootReals)
  const corpus = await getCorpusStats({ brainDirReal, rootReals, jobId, fallbackCandidates: candidates })
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

export type BrainReadResult = { ok: true; note: BrainNoteFull } | { ok: false; error: string }

/** Read ONE note in full by reference (a vault path, a reader URL, or a unique title/suffix).
 * Same scope boundary as search: the note must resolve (realpath) under a root, with no dot
 * segment, not a journal by path or frontmatter. The listing that resolves a suffix is the
 * whole in-scope corpus, so an ambiguous reference is reported with its candidates, never
 * guessed. Never throws. */
export async function readBrainNote(reference: string, jobId = '-'): Promise<BrainReadResult> {
  if (!env.BRAIN_DIR || !env.BRAIN_BASE_URL) return { ok: false, error: 'brainNotes is not configured on this host' }
  const ref = parseNoteRef(reference, env.BRAIN_BASE_URL)
  if (ref === null) return { ok: false, error: `not a note reference: ${reference}` }

  let brainDirReal: string
  try {
    brainDirReal = await realpath(env.BRAIN_DIR)
  } catch (err) {
    log('tool.brainNotes', { jobId, read: ref, ok: false, error: `BRAIN_DIR unreadable: ${String(err)}` })
    return { ok: false, error: 'brain vault is unreadable on this host' }
  }
  const rootReals = await resolveRoots(brainDirReal)
  const listing = await listAllFiles(rootReals, jobId)
  if (!listing.ok) return { ok: false, error: `brain listing failed: ${listing.error}` }

  const relPaths = listing.paths.map((p) => relative(brainDirReal, p))
  const pick = pickNoteByRef(relPaths, ref)
  if (pick.kind === 'none') {
    log('tool.brainNotes', { jobId, read: ref, ok: false, error: 'no such note' })
    return { ok: false, error: `no note at "${ref}" in the owner's brain — search with a query instead` }
  }
  if (pick.kind === 'ambiguous') {
    return { ok: false, error: `"${ref}" matches several notes — read one of: ${pick.candidates.join(', ')}` }
  }

  const [candidate] = await readScopedCandidates([join(brainDirReal, pick.relPath)], brainDirReal, rootReals)
  const frontmatterBlock = candidate?.content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  if (!candidate || isJournalNote(frontmatterBlock)) {
    log('tool.brainNotes', { jobId, read: ref, ok: false, error: 'out of scope' })
    return { ok: false, error: `the note "${ref}" is outside what research may read` }
  }
  const note = buildFullNote({ relPath: candidate.relPath, content: candidate.content, baseUrl: env.BRAIN_BASE_URL })
  if (!note) return { ok: false, error: 'brain reader URL is not configured' }
  log('tool.brainNotes', { jobId, read: candidate.relPath, chars: note.content.length, truncated: note.truncated, ok: true })
  return { ok: true, note }
}
