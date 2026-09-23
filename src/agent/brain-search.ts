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
import { readCappedText } from './pdf-extract.js'
import { rankAndBuildNotes, parseQueryTerms } from './brain.js'
import type { BrainCandidate, BrainNoteResult } from './brain.js'

// A hang guard, not a tuning default — ripgrep over a few hundred small markdown files should
// resolve in well under a second; this only bounds a pathological case (a vault grown huge, a
// wedged process).
const RG_TIMEOUT_MS = 10_000
const MAX_RG_OUTPUT_BYTES = 4 * 1024 * 1024
// Guards a symlink resolving to something enormous outside the vault's normal note size —
// defense in depth on TOP of the realpath scope check, not a substitute for it.
const MAX_NOTE_BYTES = 2 * 1024 * 1024

export type BrainSearchResult =
  | { ok: true; notes: BrainNoteResult[] }
  | { ok: false; error: string }

async function runRg(terms: string[], wikiDirReal: string, jobId: string): Promise<{ ok: boolean; paths: string[]; error?: string }> {
  const args = ['--files-with-matches', '--ignore-case', '--fixed-strings', '--glob', '*.md']
  for (const term of terms) args.push('-e', term)
  args.push(wikiDirReal)

  try {
    const proc = Bun.spawn([env.RG_PATH, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: RG_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    const [stdout, stderr] = await Promise.all([
      readCappedText(proc.stdout, MAX_RG_OUTPUT_BYTES),
      readCappedText(proc.stderr, MAX_RG_OUTPUT_BYTES),
    ])
    const code = await proc.exited

    // `proc.signalCode`, not `proc.killed` — the same Bun trap documented in ytdlp.ts's
    // runYtdlp: measured true on both a SIGKILL and a clean fast exit alike. signalCode is
    // null on any exit the process chose for itself and 'SIGKILL' only when the timeout fired.
    if (proc.signalCode) {
      return { ok: false, paths: [], error: `ripgrep timed out after ${RG_TIMEOUT_MS}ms` }
    }
    // rg's exit code convention: 0 = matches found, 1 = no matches (not an error), 2 = a real
    // error (bad glob, missing binary behaviour, etc.).
    if (code === 1) return { ok: true, paths: [] }
    if (code !== 0) {
      const reason = stderr.split('\n').find((l) => l.trim().length > 0)?.trim() ?? `ripgrep exited ${code}`
      log('tool.brainNotes', { jobId, ok: false, error: reason })
      return { ok: false, paths: [], error: reason }
    }
    const paths = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    return { ok: true, paths }
  } catch (err) {
    return { ok: false, paths: [], error: String(err) }
  }
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
    log('tool.brainNotes', { jobId, query, terms, results: 0, ok: true })
    return { ok: true, notes: [] }
  }

  const candidates = await readScopedCandidates(rg.paths, brainDirReal, wikiDirReal)
  const notes = rankAndBuildNotes({ candidates, terms, baseUrl: env.BRAIN_BASE_URL })
  log('tool.brainNotes', { jobId, query, terms, candidates: candidates.length, results: notes.length, ok: true })
  return { ok: true, notes }
}
