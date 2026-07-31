import { tool } from 'ai'
import type { Tool } from 'ai'
import { z } from 'zod'
import { env } from '../env.js'
import { log } from '../lib/log.js'
import { capText, TEXT_CAP } from './extract.js'
import { badPackageName, badPath, badRepoArg, rerankByName } from './validate.js'
import type { RetrievalLedger } from './ledger.js'

// Direct source-of-truth tools: fixed, well-known APIs that answer a question EXACTLY
// rather than approximately. Search-then-read is an inference chain — "which page ranks,
// what did the page say, did the model read it right"; these are a lookup.
//
// This is the other half of the issue #1 fix. Grounding stops a bad answer from being
// presented as verified; these stop the answer from being wrong in the first place. The
// Immich repro is the canonical case: the ground truth was one unauthenticated GET of
// `docker/docker-compose.yml`, while the pipeline was rate-limited scraping a docs page
// and guessing `2283:3001` from priors.
//
// Contract shared with tools.ts: NEVER throw (an uncaught throw kills the worker and
// loses every digest it gathered) and always tell the ledger what happened, so a lookup
// that failed can never silently back a citation.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = Tool<any, any>

const UA = 'research-gateway/0.1 (+research bot)'
const TIMEOUT_MS = 10_000

// GitHub's unauthenticated budget is 60 requests/hour PER IP — shared by every worker of
// every concurrent job on the VPS, so it is exhausted by a couple of busy runs. With
// GITHUB_TOKEN set it is 5000/hour. The tools work either way; the token only decides
// how often they degrade to "rate limited" (and, being on the ledger, refuse to be cited).
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': UA,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }
  if (env.GITHUB_TOKEN) headers['authorization'] = `Bearer ${env.GITHUB_TOKEN}`
  return headers
}

interface JsonResult<T> {
  ok: boolean
  data?: T
  error?: string
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<JsonResult<T>> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) {
      // Surface the rate-limit case explicitly — "403" alone reads like a permissions
      // problem and sends the model looking for another route instead of reporting a gap.
      const remaining = res.headers.get('x-ratelimit-remaining')
      if ((res.status === 403 || res.status === 429) && remaining === '0') {
        return { ok: false, error: `rate limited by the API (HTTP ${res.status}); this lookup could not be performed` }
      }
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` }
    }
    return { ok: true, data: (await res.json()) as T }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

// ── packageInfo ──────────────────────────────────────────────────────────────
// The single highest-value lookup here: "what version of X is current" is the most common
// question this gateway is asked, and a model's answer to it is stale by construction.

interface NpmManifest {
  version?: string
  description?: string
  license?: string
  homepage?: string
  repository?: { url?: string } | string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  engines?: Record<string, string>
  deprecated?: string
}

interface NpmPackument {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, unknown>
  modified?: string
}

interface PypiResponse {
  info?: {
    version?: string
    summary?: string
    license?: string
    requires_python?: string
    requires_dist?: string[]
    home_page?: string
    project_urls?: Record<string, string>
    yanked?: boolean
  }
  releases?: Record<string, unknown>
}

async function lookupNpm(name: string, ledger: RetrievalLedger): Promise<unknown> {
  const apiUrl = `https://registry.npmjs.org/${name.split('/').map(encodeURIComponent).join('/')}`
  const pageUrl = `https://www.npmjs.com/package/${name}`

  const [manifest, packument] = await Promise.all([
    getJson<NpmManifest>(`${apiUrl}/latest`, { 'user-agent': UA }),
    // The abbreviated packument carries dist-tags and the version list at a fraction of
    // the full document's size.
    getJson<NpmPackument>(apiUrl, { 'user-agent': UA, accept: 'application/vnd.npm.install-v1+json' }),
  ])

  if (!manifest.ok || !manifest.data) {
    const error = manifest.error ?? 'not found'
    ledger.recordFailed(pageUrl, error)
    return { error: `npm lookup failed for "${name}": ${error}` }
  }

  ledger.recordRetrieved(pageUrl)
  ledger.recordRetrieved(apiUrl)

  const m = manifest.data
  const tags = packument.data?.['dist-tags'] ?? {}
  return {
    ecosystem: 'npm',
    name,
    latestVersion: m.version ?? tags['latest'] ?? null,
    distTags: tags,
    description: m.description ?? null,
    license: m.license ?? null,
    deprecated: m.deprecated ?? null,
    homepage: m.homepage ?? null,
    repository: typeof m.repository === 'string' ? m.repository : (m.repository?.url ?? null),
    dependencies: m.dependencies ?? {},
    peerDependencies: m.peerDependencies ?? {},
    engines: m.engines ?? {},
    lastPublished: packument.data?.modified ?? null,
    sourceUrl: pageUrl,
    note: 'Authoritative: read live from the npm registry. Cite sourceUrl. Prefer these exact strings over any version you remember.',
  }
}

async function lookupPypi(name: string, ledger: RetrievalLedger): Promise<unknown> {
  const apiUrl = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
  const pageUrl = `https://pypi.org/project/${name}/`

  const res = await getJson<PypiResponse>(apiUrl, { 'user-agent': UA, accept: 'application/json' })
  if (!res.ok || !res.data?.info) {
    const error = res.error ?? 'not found'
    ledger.recordFailed(pageUrl, error)
    return { error: `PyPI lookup failed for "${name}": ${error}` }
  }

  ledger.recordRetrieved(pageUrl)
  ledger.recordRetrieved(apiUrl)

  const i = res.data.info
  return {
    ecosystem: 'pypi',
    name,
    latestVersion: i.version ?? null,
    description: i.summary ?? null,
    license: i.license ?? null,
    requiresPython: i.requires_python ?? null,
    dependencies: i.requires_dist ?? [],
    yanked: i.yanked ?? false,
    homepage: i.home_page || null,
    projectUrls: i.project_urls ?? {},
    releaseCount: Object.keys(res.data.releases ?? {}).length,
    sourceUrl: pageUrl,
    note: 'Authoritative: read live from the PyPI JSON API. Cite sourceUrl. Prefer these exact strings over any version you remember.',
  }
}

function buildPackageInfoTool(ledger: RetrievalLedger, jobId: string): AnyTool {
  return tool({
    description:
      'Look up the AUTHORITATIVE current metadata for a published package straight from its registry: exact latest version, all dist-tags (latest/next/beta), license, dependencies, deprecation status and repository URL. Use this for ANY question about what version of a package is current, what it depends on, or whether it is deprecated — it is exact where search results and model memory are stale. Prefer it over searchWeb for these questions.',
    inputSchema: z.object({
      ecosystem: z.enum(['npm', 'pypi']).describe('Which registry to query'),
      name: z.string().describe('Exact package name, e.g. "elysia", "@ai-sdk/openai-compatible", "httpx"'),
    }),
    execute: async ({ ecosystem, name }) => {
      const clean = name.trim()
      const nameError = badPackageName(clean)
      if (nameError) return { error: nameError }
      const out = ecosystem === 'npm' ? await lookupNpm(clean, ledger) : await lookupPypi(clean, ledger)
      log('tool.packageInfo', { jobId, ecosystem, name: clean, ok: !(out as { error?: string }).error })
      return out
    },
  }) as AnyTool
}

// ── githubFile ───────────────────────────────────────────────────────────────
// Reads a file from a repo verbatim. This is the tool that would have answered the Immich
// question correctly in one call.

interface GhRepo {
  full_name?: string
  description?: string
  stargazers_count?: number
  forks_count?: number
  open_issues_count?: number
  default_branch?: string
  archived?: boolean
  pushed_at?: string
  created_at?: string
  homepage?: string
  topics?: string[]
  license?: { spdx_id?: string } | null
  html_url?: string
}

interface GhRelease {
  tag_name?: string
  name?: string
  published_at?: string
  html_url?: string
  prerelease?: boolean
}

function buildGithubFileTool(ledger: RetrievalLedger, jobId: string): AnyTool {
  return tool({
    description:
      'Read a file from a GitHub repository VERBATIM (raw bytes, no rendering, no summarising). Use this whenever the answer lives in a repo file — docker-compose.yml, package.json, a config example, a README, a source file, a CHANGELOG. This is exact where a docs page is a paraphrase: prefer it over fetchPage for anything that exists in a repository.',
    inputSchema: z.object({
      owner: z.string().describe('Repository owner, e.g. "immich-app"'),
      repo: z.string().describe('Repository name, e.g. "immich"'),
      path: z.string().describe('Repo-relative file path, e.g. "docker/docker-compose.yml"'),
      ref: z
        .string()
        .optional()
        .describe('Branch, tag or commit SHA. Omit for the default branch. Use a release tag (e.g. "v3.1.0") when the question is about a specific release.'),
    }),
    execute: async ({ owner, repo, path, ref }) => {
      const argError = badRepoArg(owner, repo, ref) ?? badPath(path)
      if (argError) return { error: argError }

      // `HEAD` resolves to the repo's default branch without spending an API call on it.
      const effectiveRef = ref ?? 'HEAD'
      const encodedPath = path.split('/').map(encodeURIComponent).join('/')
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${effectiveRef}/${encodedPath}`
      // The blob URL is what a human (and a model) naturally cites; both go on the ledger
      // so a citation to either form is recognised as grounded.
      const blobUrl = `https://github.com/${owner}/${repo}/blob/${effectiveRef}/${encodedPath}`

      try {
        const res = await fetch(rawUrl, {
          headers: { 'user-agent': UA, ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!res.ok) {
          const reason =
            res.status === 404
              ? `not found — no file at "${path}" on ref "${effectiveRef}" (check the path and ref)`
              : `HTTP ${res.status} ${res.statusText}`
          ledger.recordFailed(blobUrl, reason)
          log('tool.githubFile', { jobId, owner, repo, path, ref: effectiveRef, ok: false, status: res.status })
          return { error: `githubFile failed: ${reason}`, url: blobUrl }
        }

        const text = await res.text()
        ledger.recordRetrieved(blobUrl)
        ledger.recordRetrieved(rawUrl)
        log('tool.githubFile', { jobId, owner, repo, path, ref: effectiveRef, ok: true, chars: text.length })
        return {
          url: blobUrl,
          rawUrl,
          ref: effectiveRef,
          content: capText(text, TEXT_CAP),
          note: 'Verbatim file content. Quote it exactly — do not normalise names, versions or values. Cite `url`.',
        }
      } catch (err) {
        ledger.recordFailed(blobUrl, String(err))
        log('tool.githubFile', { jobId, owner, repo, path, ok: false, error: String(err) })
        return { error: `githubFile failed: ${String(err)}`, url: blobUrl }
      }
    },
  }) as AnyTool
}

// ── githubRepo ───────────────────────────────────────────────────────────────

function buildGithubRepoTool(ledger: RetrievalLedger, jobId: string): AnyTool {
  return tool({
    description:
      'Get authoritative facts about a GitHub repository: description, stars, license, topics, default branch, whether it is ARCHIVED, when it was last pushed to, and its latest release tag and date. Use this to check whether a project is alive and which release is current, rather than inferring it from blog posts.',
    inputSchema: z.object({
      owner: z.string().describe('Repository owner, e.g. "immich-app"'),
      repo: z.string().describe('Repository name, e.g. "immich"'),
    }),
    execute: async ({ owner, repo }) => {
      const argError = badRepoArg(owner, repo)
      if (argError) return { error: argError }

      const pageUrl = `https://github.com/${owner}/${repo}`
      const [repoRes, releaseRes] = await Promise.all([
        getJson<GhRepo>(`https://api.github.com/repos/${owner}/${repo}`, githubHeaders()),
        // A repo with no releases 404s here; that is a fact, not a failure.
        getJson<GhRelease>(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, githubHeaders()),
      ])

      if (!repoRes.ok || !repoRes.data) {
        const error = repoRes.error ?? 'not found'
        ledger.recordFailed(pageUrl, error)
        log('tool.githubRepo', { jobId, owner, repo, ok: false })
        return { error: `githubRepo failed for ${owner}/${repo}: ${error}` }
      }

      ledger.recordRetrieved(pageUrl)
      const d = repoRes.data
      const rel = releaseRes.ok ? releaseRes.data : undefined
      log('tool.githubRepo', { jobId, owner, repo, ok: true })
      return {
        fullName: d.full_name ?? `${owner}/${repo}`,
        description: d.description ?? null,
        stars: d.stargazers_count ?? null,
        forks: d.forks_count ?? null,
        openIssues: d.open_issues_count ?? null,
        defaultBranch: d.default_branch ?? null,
        archived: d.archived ?? false,
        lastPushedAt: d.pushed_at ?? null,
        createdAt: d.created_at ?? null,
        homepage: d.homepage || null,
        topics: d.topics ?? [],
        license: d.license?.spdx_id ?? null,
        latestRelease: rel?.tag_name
          ? { tag: rel.tag_name, name: rel.name ?? null, publishedAt: rel.published_at ?? null, prerelease: rel.prerelease ?? false, url: rel.html_url ?? null }
          : null,
        sourceUrl: pageUrl,
        note: 'Authoritative: read live from the GitHub API. Cite sourceUrl.',
      }
    },
  }) as AnyTool
}

// ── findPackages ─────────────────────────────────────────────────────────────
// Discovery, ranked by real signals (npm popularity score, GitHub stars + recency) rather
// than by whatever a listicle happened to rank for.

interface NpmSearchResponse {
  objects?: Array<{
    package?: { name?: string; version?: string; description?: string; date?: string; links?: Record<string, string> }
    score?: { final?: number; detail?: { quality?: number; popularity?: number; maintenance?: number } }
  }>
}

interface GhSearchResponse {
  items?: Array<{
    full_name?: string
    description?: string
    stargazers_count?: number
    pushed_at?: string
    archived?: boolean
    language?: string
    license?: { spdx_id?: string } | null
    html_url?: string
  }>
}

function buildFindPackagesTool(ledger: RetrievalLedger, jobId: string): AnyTool {
  return tool({
    description:
      'Discover libraries, tools or projects that solve a problem, ranked by real adoption signals — npm popularity/quality/maintenance scores, or GitHub stars and last-push date. Use this for "what library should I use for X", "what are the current options for X", or "what is popular/trending in X", instead of trusting a blog listicle. Returns candidates to then verify with packageInfo or githubRepo.',
    inputSchema: z.object({
      registry: z
        .enum(['npm', 'github'])
        .describe('npm = JS/TS packages ranked by npm score; github = repositories ranked by stars'),
      query: z.string().describe('What the library should do, e.g. "typescript http client" or "self-hosted photo management"'),
    }),
    execute: async ({ registry, query }) => {
      const q = query.trim()
      if (q.length < 2) return { error: 'query too short' }

      if (registry === 'npm') {
        const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=10`
        const res = await getJson<NpmSearchResponse>(url, { 'user-agent': UA })
        if (!res.ok || !res.data) {
          log('tool.findPackages', { jobId, registry, ok: false })
          return { error: `npm search failed: ${res.error ?? 'no results'}` }
        }
        ledger.recordRetrieved(url)
        const results = rerankByName(
          q,
          res.data.objects ?? [],
          (o) => o.package?.name ?? '',
        ).map((o) => ({
          name: o.package?.name ?? null,
          version: o.package?.version ?? null,
          description: o.package?.description ?? null,
          lastPublished: o.package?.date ?? null,
          npmUrl: o.package?.links?.['npm'] ?? null,
          repository: o.package?.links?.['repository'] ?? null,
          score: o.score?.final ?? null,
          popularity: o.score?.detail?.popularity ?? null,
          maintenance: o.score?.detail?.maintenance ?? null,
        }))
        // Each candidate's npm page is a real page — record it so a follow-up citation to
        // it is grounded without another round-trip.
        for (const r of results) if (r.npmUrl) ledger.recordSnippet(r.npmUrl)
        log('tool.findPackages', { jobId, registry, results: results.length, ok: true })
        return { registry, query: q, results, note: 'Ranked by npm score. Confirm the winner with packageInfo before citing a version.' }
      }

      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=10`
      const res = await getJson<GhSearchResponse>(url, githubHeaders())
      if (!res.ok || !res.data) {
        log('tool.findPackages', { jobId, registry, ok: false })
        return { error: `GitHub search failed: ${res.error ?? 'no results'}` }
      }
      ledger.recordRetrieved(url)
      const results = (res.data.items ?? []).map((r) => ({
        fullName: r.full_name ?? null,
        description: r.description ?? null,
        stars: r.stargazers_count ?? null,
        lastPushedAt: r.pushed_at ?? null,
        archived: r.archived ?? false,
        language: r.language ?? null,
        license: r.license?.spdx_id ?? null,
        url: r.html_url ?? null,
      }))
      for (const r of results) if (r.url) ledger.recordSnippet(r.url)
      log('tool.findPackages', { jobId, registry, results: results.length, ok: true })
      return {
        registry,
        query: q,
        results,
        note: 'Ranked by stars — check lastPushedAt and archived before recommending anything. Confirm details with githubRepo.',
      }
    },
  }) as AnyTool
}

export function buildDirectSourceTools(ledger: RetrievalLedger, jobId: string): Record<string, AnyTool> {
  return {
    packageInfo: buildPackageInfoTool(ledger, jobId),
    githubFile: buildGithubFileTool(ledger, jobId),
    githubRepo: buildGithubRepoTool(ledger, jobId),
    findPackages: buildFindPackagesTool(ledger, jobId),
  }
}
