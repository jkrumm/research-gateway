import { tool } from 'ai'
import type { Tool } from 'ai'
import { z } from 'zod'
import { env } from '../env.js'
import { log } from '../lib/log.js'
import { capText, TEXT_CAP } from './extract.js'
import {
  badDockerName,
  badPackageName,
  badPath,
  badRepoArg,
  escapeGoModulePath,
  resolveDockerName,
  rerankByName,
} from './validate.js'
import type { RetrievalLedger } from './ledger.js'
import { mapOpenAlexWork, mapPubmedRecord, parsePubmedIds } from './academic.js'
import type { OpenAlexWork, PubmedEsearchResult, PubmedResult, PubmedSummaryRecord } from './academic.js'
import { searchYoutube } from './ytdlp.js'

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

// Shared by every registry lookup below (npm/pypi/crates/go/docker): each does an ok-check,
// an error-shaped early return, then two ledger.recordRetrieved calls before mapping its own
// fields. Five hand-copied versions of this already existed (three added this week) with no
// shared source — the ledger is what gates citations, so a sixth copy that dropped a
// recordRetrieved call or swapped pageUrl/apiUrl would silently make a retrieved page
// ineligible as a citation source and nothing would catch it. `pick` extracts the ecosystem's
// "found" payload from the raw response, so the success branch below narrows `core` to a
// defined value without a type assertion at any call site. Returns the error object to
// return immediately, or the narrowed payload to continue into the field mapping.
function checkRegistryResult<T, C>(params: {
  res: JsonResult<T>
  pick: (data: T | undefined) => C | undefined
  registryLabel: string
  name: string
  pageUrl: string
  apiUrl: string
  ledger: RetrievalLedger
}): { error: string } | { core: C } {
  const { res, pick, registryLabel, name, pageUrl, apiUrl, ledger } = params
  const core = pick(res.data)
  if (!res.ok || !core) {
    const message = res.error ?? 'not found'
    ledger.recordFailed(pageUrl, message)
    return { error: `${registryLabel} lookup failed for "${name}": ${message}` }
  }
  ledger.recordRetrieved(pageUrl)
  ledger.recordRetrieved(apiUrl)
  return { core }
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

  const check = checkRegistryResult({
    res: manifest,
    pick: (data) => data,
    registryLabel: 'npm',
    name,
    pageUrl,
    apiUrl,
    ledger,
  })
  if ('error' in check) return check

  const m = check.core
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
  const check = checkRegistryResult({
    res,
    pick: (data) => data?.info,
    registryLabel: 'PyPI',
    name,
    pageUrl,
    apiUrl,
    ledger,
  })
  if ('error' in check) return check

  const i = check.core
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
    releaseCount: Object.keys(res.data?.releases ?? {}).length,
    sourceUrl: pageUrl,
    note: 'Authoritative: read live from the PyPI JSON API. Cite sourceUrl. Prefer these exact strings over any version you remember.',
  }
}

interface CratesResponse {
  crate?: {
    max_stable_version?: string
    newest_version?: string
    description?: string
    homepage?: string
    documentation?: string
    repository?: string
    downloads?: number
    recent_downloads?: number
    yanked?: boolean
    num_versions?: number
  }
  // Top-level `versions` (full objects), distinct from `crate.versions` (an id list) — this
  // is where the per-version `license` actually lives, so the stable release's license is
  // found by matching its `num` against `crate.max_stable_version`.
  versions?: Array<{ num?: string; license?: string | null }>
}

async function lookupCrates(name: string, ledger: RetrievalLedger): Promise<unknown> {
  const apiUrl = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`
  const pageUrl = `https://crates.io/crates/${name}`

  // crates.io's crawler policy expects a User-Agent that identifies the caller; `UA`
  // already does and was verified working against this endpoint.
  const res = await getJson<CratesResponse>(apiUrl, { 'user-agent': UA, accept: 'application/json' })
  const check = checkRegistryResult({
    res,
    pick: (data) => data?.crate,
    registryLabel: 'crates.io',
    name,
    pageUrl,
    apiUrl,
    ledger,
  })
  if ('error' in check) return check

  const c = check.core
  const stableEntry = res.data?.versions?.find((v) => v.num === c.max_stable_version)
  return {
    ecosystem: 'crates',
    name,
    // `max_stable_version`, not `newest_version` — "what version is current" almost always
    // means the stable one, and `newest_version` can be a prerelease ahead of it.
    latestVersion: c.max_stable_version ?? null,
    newestVersion: c.newest_version ?? null,
    description: c.description ?? null,
    license: stableEntry?.license ?? null,
    homepage: c.homepage ?? null,
    documentation: c.documentation ?? null,
    repository: c.repository ?? null,
    downloads: c.downloads ?? null,
    recentDownloads: c.recent_downloads ?? null,
    yanked: c.yanked ?? false,
    versionCount: c.num_versions ?? null,
    sourceUrl: pageUrl,
    note: 'Authoritative: read live from the crates.io registry. Cite sourceUrl. latestVersion is the stable release; newestVersion may be a prerelease. Prefer these exact strings over any version you remember.',
  }
}

interface GoProxyResponse {
  Version?: string
  Time?: string
  Origin?: { VCS?: string; URL?: string; Ref?: string }
}

async function lookupGo(moduleName: string, ledger: RetrievalLedger): Promise<unknown> {
  const apiUrl = `https://proxy.golang.org/${escapeGoModulePath(moduleName)}/@latest`
  // pkg.go.dev has no JSON API of its own — the module proxy IS the authoritative
  // machine-readable source (MEASURED against proxy.golang.org/github.com/gin-gonic/gin).
  // pkg.go.dev is still the page a citation should name: it's the human-readable one.
  const pageUrl = `https://pkg.go.dev/${moduleName}`

  const res = await getJson<GoProxyResponse>(apiUrl, { 'user-agent': UA, accept: 'application/json' })
  const check = checkRegistryResult({
    res,
    pick: (data) => (data?.Version ? data : undefined),
    registryLabel: 'Go module proxy',
    name: moduleName,
    pageUrl,
    apiUrl,
    ledger,
  })
  if ('error' in check) return check

  const d = check.core
  return {
    ecosystem: 'go',
    name: moduleName,
    latestVersion: d.Version,
    publishedAt: d.Time ?? null,
    vcs: d.Origin?.VCS ?? null,
    repositoryUrl: d.Origin?.URL ?? null,
    ref: d.Origin?.Ref ?? null,
    sourceUrl: pageUrl,
    note: 'Authoritative: read live from the Go module proxy (proxy.golang.org). Cite sourceUrl. Prefer this exact version string over any version you remember.',
  }
}

interface DockerTagsResponse {
  count?: number
  results?: Array<{ name?: string; last_updated?: string; full_size?: number }>
}

async function lookupDocker(name: string, ledger: RetrievalLedger): Promise<unknown> {
  const nameError = badDockerName(name)
  if (nameError) return { error: nameError }

  const { namespace, repo, pageUrl } = resolveDockerName(name)
  const apiUrl = `https://hub.docker.com/v2/repositories/${namespace}/${repo}/tags?page_size=25&ordering=last_updated`

  const res = await getJson<DockerTagsResponse>(apiUrl, { 'user-agent': UA, accept: 'application/json' })
  const check = checkRegistryResult({
    res,
    pick: (data) => data,
    registryLabel: 'Docker Hub',
    name,
    pageUrl,
    apiUrl,
    ledger,
  })
  if ('error' in check) return check

  const tags = (check.core.results ?? []).map((t) => ({
    name: t.name ?? null,
    lastUpdated: t.last_updated ?? null,
    sizeBytes: t.full_size ?? null,
  }))
  return {
    ecosystem: 'docker',
    name: `${namespace}/${repo}`,
    tags,
    tagCount: check.core.count ?? tags.length,
    sourceUrl: pageUrl,
    // Deliberately no `latestVersion` key: every other ecosystem's `latestVersion` names a
    // real version, but docker's `latest` is a mutable pointer the maintainer can repoint at
    // any time and frequently is not the newest build. Returning it under the same key a
    // model already trusts from npm/pypi/crates/go would invite exactly the wrong answer —
    // read `tags` and their `lastUpdated` instead. This asymmetry is deliberate; don't "fix"
    // it back to matching the others.
    note: '"latest" is a moving tag, not a version — read the tags array and their lastUpdated dates to find the current one. Cite sourceUrl.',
  }
}

// Single source of truth for the ecosystem set: both PACKAGE_LOOKUPS's key type and the
// zod enum below are derived from this array, so adding a sixth ecosystem to one and not
// the other is a type error instead of a silent drift.
const ECOSYSTEMS = ['npm', 'pypi', 'crates', 'go', 'docker'] as const
type Ecosystem = (typeof ECOSYSTEMS)[number]

// Ecosystem dispatch as a lookup map rather than a growing if/else — stays readable as new
// ecosystems are added, and each branch already has an identical (name, ledger) signature.
const PACKAGE_LOOKUPS: Record<Ecosystem, (name: string, ledger: RetrievalLedger) => Promise<unknown>> = {
  npm: lookupNpm,
  pypi: lookupPypi,
  crates: lookupCrates,
  go: lookupGo,
  docker: lookupDocker,
}

function buildPackageInfoTool(ledger: RetrievalLedger, jobId: string): AnyTool {
  return tool({
    description:
      'Look up the AUTHORITATIVE current metadata for a published package straight from its registry: exact latest version, dist-tags/license/dependencies/deprecation (npm, pypi), crate metadata (crates.io), module version and VCS origin (go, via the Go module proxy), or the tag list (docker, via Docker Hub — images have no single "latest version", read the tags and their dates). Use this for ANY question about what version of a package, crate, module or image is current, what it depends on, or whether it is deprecated — it is exact where search results and model memory are stale. Prefer it over searchWeb for these questions.',
    inputSchema: z.object({
      ecosystem: z.enum(ECOSYSTEMS).describe('Which registry to query'),
      name: z
        .string()
        .describe(
          'Exact package/module/image name, e.g. "elysia", "@ai-sdk/openai-compatible", "httpx", "serde", "github.com/gin-gonic/gin", "postgres" or "grafana/grafana"',
        ),
    }),
    execute: async ({ ecosystem, name }) => {
      const clean = name.trim()
      const nameError = badPackageName(clean)
      if (nameError) return { error: nameError }
      const out = await PACKAGE_LOOKUPS[ecosystem](clean, ledger)
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
          // A 404 is nearly always a guessed tag, not a missing file. Observed live: five
          // wasted steps guessing `v1.4.29`/`v1.0.0` for a repo that tags `1.4.29`. Say so
          // instead of leaving the model to brute-force prefixes.
          const refHint =
            ref === undefined
              ? ' The default branch was used, so the path is the likely problem.'
              : ` Tag naming is per-repo — "${ref}" may need its "v" prefix added or removed. Call githubRepo({ owner: "${owner}", repo: "${repo}" }) for the exact latestRelease.tag rather than guessing, or omit ref to read the default branch.`
          const reason =
            res.status === 404
              ? `not found — no file at "${path}" on ref "${effectiveRef}".${refHint}`
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

// ── academicSearch ───────────────────────────────────────────────────────────
// One tool covering two literature indexes, not two tools — see the tool-count comment on
// `buildDirectSourceTools` for why that split matters here.

interface OpenAlexSearchResponse {
  meta?: { count?: number }
  results?: OpenAlexWork[]
}

async function lookupOpenAlex(query: string, limit: number, ledger: RetrievalLedger): Promise<unknown> {
  // `select` trims the response to only the fields mapOpenAlexWork reads — see academic.ts
  // for why the unselected response is out of budget for a worker call.
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${limit}&select=id,doi,title,publication_year,cited_by_count,open_access,primary_location,authorships,type`

  const res = await getJson<OpenAlexSearchResponse>(url, { 'user-agent': UA, accept: 'application/json' })
  if (!res.ok || !res.data) {
    const error = res.error ?? 'no results'
    ledger.recordFailed(url, error)
    return { error: `OpenAlex search failed: ${error}` }
  }

  ledger.recordRetrieved(url)
  const results = (res.data.results ?? []).map(mapOpenAlexWork)
  // Every URL a model can cite from this response must be on the ledger, or groundDigest
  // strips the finding at the worker boundary before it ever reaches synthesis. MEASURED:
  // recording only the query URL above cost 9 of 14 findings in one job — the worker cited
  // works by DOI and landing page, neither of which the ledger had seen.
  //
  // `snippet`, not `retrieved`: this is a bibliographic record, not the paper. That is
  // exactly the tier's definition ("seen, not read") and it caps such a claim at `medium`
  // confidence in ground.ts, which is the honest ceiling for "OpenAlex says this paper has
  // N citations" when nothing read the paper.
  for (const r of results) {
    if (r.landingPageUrl) ledger.recordSnippet(r.landingPageUrl)
    if (r.doi) ledger.recordSnippet(r.doi)
    if (r.openAccessUrl) ledger.recordSnippet(r.openAccessUrl)
  }
  return {
    source: 'openalex',
    query,
    totalCount: res.data.meta?.count ?? results.length,
    results,
    // OpenAlex offers a "polite pool" (a `mailto` query param) with more reliable rate
    // limits. Deliberately not wired up here — that means shipping a real address into
    // config for a keyless service that measured fine without one. This is the lever to
    // pull if OpenAlex reliability ever becomes the problem.
    note: 'Authoritative bibliographic metadata from OpenAlex (keyless). Cite doi or landingPageUrl.',
  }
}

async function lookupPubmed(query: string, limit: number, ledger: RetrievalLedger): Promise<unknown> {
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retmode=json`

  const searchRes = await getJson<PubmedEsearchResult>(searchUrl, { 'user-agent': UA, accept: 'application/json' })
  if (!searchRes.ok || !searchRes.data) {
    const error = searchRes.error ?? 'no results'
    ledger.recordFailed(searchUrl, error)
    return { error: `PubMed search failed: ${error}` }
  }
  ledger.recordRetrieved(searchUrl)

  const { ids, totalCount } = parsePubmedIds(searchRes.data)
  // An empty id list is a real "no hits" answer, not a failure — do NOT call esummary with
  // an empty id list, it is a wasted round trip for a query eutils has already answered.
  if (ids.length === 0) {
    return { source: 'pubmed', query, totalCount, results: [], note: 'No PubMed hits for this query.' }
  }

  const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`
  const summaryRes = await getJson<{ result?: Record<string, PubmedSummaryRecord> }>(summaryUrl, {
    'user-agent': UA,
    accept: 'application/json',
  })
  if (!summaryRes.ok || !summaryRes.data) {
    const error = summaryRes.error ?? 'no summaries'
    ledger.recordFailed(summaryUrl, error)
    return { error: `PubMed summary lookup failed: ${error}` }
  }
  ledger.recordRetrieved(summaryUrl)

  const results: PubmedResult[] = []
  for (const uid of ids) {
    const record = summaryRes.data.result?.[uid]
    if (!record) continue
    const mapped = mapPubmedRecord(uid, record)
    results.push(mapped)
    // Each result's own PubMed page is the URL a citation will name — record it directly,
    // not just the search/summary API endpoints.
    //
    // `snippet`, not `retrieved`, and the distinction is load-bearing: esummary returns a
    // bibliographic record, not the paper. `retrieved` would let a model assert `high`
    // confidence about a study nothing in this run actually read. `snippet` caps it at
    // `medium` in ground.ts, which is what "PubMed's index says so" is worth.
    ledger.recordSnippet(mapped.url)
    if (mapped.doi) ledger.recordSnippet(`https://doi.org/${mapped.doi}`)
  }

  return {
    source: 'pubmed',
    query,
    totalCount,
    results,
    note: "Authoritative bibliographic metadata from PubMed/NCBI (keyless). Cite each result's url.",
  }
}

function buildAcademicSearchTool(ledger: RetrievalLedger, jobId: string): AnyTool {
  return tool({
    description:
      'Search academic/scientific literature for authoritative bibliographic metadata: title, authors, year, citation count, DOI, open-access link. Use `openalex` for broad multi-disciplinary coverage (works, preprints, citation counts) and `pubmed` for biomedical/life-science literature specifically. Prefer this over searchWeb for "who wrote / what year / how many citations / is there a paper on X" questions.',
    inputSchema: z.object({
      source: z.enum(['openalex', 'pubmed']).describe('Which index to query'),
      query: z.string().describe('Search terms, e.g. "retrieval augmented generation survey"'),
      limit: z.number().int().min(1).max(10).default(5).describe('Max results to return'),
    }),
    execute: async ({ source, query, limit }) => {
      const q = query.trim()
      if (q.length < 2) return { error: 'query too short' }

      // Semantic Scholar is deliberately NOT a third `source` value: MEASURED 2026-08-03,
      // unauthenticated api.semanticscholar.org/graph/v1/paper/search returned HTTP 429 on
      // all three consecutive calls from the VPS (the IP that matters for this gateway) and
      // 200-then-429-then-429 from a residential IP. It is unusable at this gateway's call
      // rate without a key. The unblock, if this is revisited: request a free key at
      // https://www.semanticscholar.org/product/api#api-key-form.
      const out = source === 'openalex' ? await lookupOpenAlex(q, limit, ledger) : await lookupPubmed(q, limit, ledger)
      log('tool.academicSearch', { jobId, source, query: q, ok: !(out as { error?: string }).error })
      return out
    },
  }) as AnyTool
}

// ── findVideos ───────────────────────────────────────────────────────────────
// Ninth tool, and the same kind of case academicSearch earned #8: a different KIND of
// question — spoken, long-form primary sources (conference talks, interviews, podcast
// episodes) — that no existing tool's shape expresses. `packageInfo`/`githubFile`/`githubRepo`
// answer "what does the code/registry say"; `academicSearch` answers "what does the literature
// say"; nothing here answers "what did a practitioner actually SAY, at length, out loud".
//
// The concrete signal only this tool returns, and the decisive one: duration. A 2:46
// explainer is someone else's summary; a 1:48:20 talk or interview is worth reading in full.
//
// This used to be a keyless HTML scrape of youtube.com's search page (~1.3 MB per call, and
// what the ~1.6 MB corpus of `ytInitialData` blobs it walked was measured against). It is now
// `searchYoutube` (agent/ytdlp.ts), `yt-dlp --flat-playlist -J "ytsearch<n>:<query>"`.
// MEASURED 2026-08-06 from the VPS: **9,795 bytes in 2,712 ms** — a 134x payload reduction —
// returning `id`/`title`/`duration` (numeric seconds)/`view_count`/`channel` per entry
// directly, which also retires the `ytInitialData` regex as a breakage surface: that blob's
// undocumented shape was the reason `parseYoutubeSearch` existed at all (see youtube.ts).
//
// This is a candidate list, not a read source: results go on the ledger as `recordSnippet`,
// never `recordRetrieved` — see the comment on that call below, and the identical reasoning
// already established for lookupOpenAlex/lookupPubmed above. Reading a video is a SEPARATE
// step: `fetchPage` on the result's `url`, which — via the YouTube site adapter (site-adapters.ts)
// and the yt-dlp step in the fetch chain (fetch-chain.ts) — returns the full transcript
// (measured 20k-80k chars in 3.6-4.2s), skipping the player-chrome success-shaped failure
// that step 1/2 of the generic chain would otherwise produce for this host.

// Per-WORKER call budget, enforced in code rather than asked for in the prompt — the same
// shape as searchWeb's `maxSearches`, and for a reason that was measured rather than assumed.
//
// The worker prompt already says "one call per question". MEASURED 2026-08-06, it was ignored:
// one `standard` job with 4 sub-questions made 13 findVideos calls, the queries plainly
// reworded retries of each other ("Bun in production JavaScript runtime podcast interview",
// "Bun podcast interview JavaScript runtime", "Bun JavaScript runtime talk", "Bun JSConf
// talk"). That is the academicSearch over-call pattern, and it is why the budget stays even
// though each call is now 134x cheaper — the failure mode being guarded against is wasted
// tool-call budget and a stuck worker re-querying the same index with different words, not
// only the payload size that originally forced the container's memory limit up.
//
// 3 is deliberately above the prompt's "one per question" so a genuinely multi-part
// sub-question is not cut off, and far below the observed 13. Unlike searchWeb's budget this
// is not depth-scaled: findVideos is a lookup, and a deep job earns more DEPTH by reading more
// transcripts, not by re-querying the same index with different words.
const MAX_FIND_VIDEOS_CALLS = 3

function buildFindVideosTool(
  ledger: RetrievalLedger,
  jobId: string,
  onYtdlp?: (r: { ok: boolean; ms: number }) => void,
): AnyTool {
  // One closure per worker (buildTools is called per worker), mirroring searchWeb's `spent`.
  let spent = 0

  return tool({
    description:
      "Find candidate videos on YouTube — conference talks, interviews, podcast episodes — and return their duration, channel and view count. Prefer long-form results over short explainer clips: check durationSeconds before choosing what to read. This is a CANDIDATE list, not a source you may cite directly — call fetchPage on a result's url to read its full transcript before citing it, and cite that url exactly as returned. Budgeted: a few calls per sub-question, so make each query count rather than rewording it.",
    inputSchema: z.object({
      query: z.string().describe('What to search for, e.g. "Rich Hickey clojure design talk"'),
      limit: z.number().int().min(1).max(10).default(5).describe('Max results to return'),
    }),
    execute: async ({ query, limit }) => {
      try {
        const q = query.trim()
        if (q.length < 2) return { error: 'query too short' }

        if (spent >= MAX_FIND_VIDEOS_CALLS) {
          log('tool.findVideos', { jobId, query: q, via: 'budget', spent, max: MAX_FIND_VIDEOS_CALLS })
          return {
            error: `findVideos budget exhausted (${MAX_FIND_VIDEOS_CALLS} calls used). Do not search for videos again — read the most promising results you already have with fetchPage, and report anything still unresolved in openGaps.`,
            results: [],
          }
        }
        // Counted before the request, so a failing call cannot be retried without limit — the
        // same reasoning as searchWeb's, where not charging failures hands a stuck worker
        // unlimited retries.
        spent++

        const started = performance.now()
        const results = await searchYoutube(q, limit, { jobId })
        onYtdlp?.({ ok: results !== null, ms: Math.round(performance.now() - started) })
        if (results === null) {
          log('tool.findVideos', { jobId, query: q, results: 0, ok: false })
          return { error: 'YouTube search failed' }
        }

        // `recordSnippet`, NOT `recordRetrieved` — mirrors lookupOpenAlex/lookupPubmed's
        // reasoning above exactly: a search hit is a candidate seen in a listing, not a
        // video actually watched. `medium` confidence (ground.ts) is the honest ceiling for
        // "this video appears to be about X" until fetchPage has actually read the
        // transcript and can back `high`.
        for (const v of results) ledger.recordSnippet(v.url)

        log('tool.findVideos', { jobId, query: q, results: results.length, ok: true })
        if (results.length === 0) {
          return { query: q, results, note: 'No YouTube results for this query.' }
        }
        return {
          query: q,
          results,
          note: "Candidates only. Call fetchPage on a result's url to read its full transcript before citing it — do not cite a result from this list directly. Prefer long-form (check durationSeconds) over short explainer clips.",
        }
      } catch (err) {
        log('tool.findVideos', { jobId, query, results: 0, ok: false })
        return { error: `findVideos failed: ${String(err)}` }
      }
    },
  }) as AnyTool
}

export function buildDirectSourceTools(
  ledger: RetrievalLedger,
  jobId: string,
  onYtdlp?: (r: { ok: boolean; ms: number }) => void,
): Record<string, AnyTool> {
  return {
    packageInfo: buildPackageInfoTool(ledger, jobId),
    githubFile: buildGithubFileTool(ledger, jobId),
    githubRepo: buildGithubRepoTool(ledger, jobId),
    findPackages: buildFindPackagesTool(ledger, jobId),
    // Tool definitions are re-sent in EVERY step's context, for EVERY worker, on EVERY job
    // (8 workers x 3 concurrent jobs measured) against a workerMaxSteps of 5/7/9 (depth.ts) —
    // a `standard` worker can make 7 tool calls total, so 12 tool definitions in front of a
    // 7-call budget is the wrong trade. That is why crates/go/docker above are three new
    // `packageInfo` ecosystems rather than three new tools: zero extra definitions.
    // academicSearch and findVideos below are the two genuinely new tools added on top of that
    // baseline, because each answers a different KIND of question that no existing tool's
    // shape can express — literature (OpenAlex/PubMed) and spoken long-form primary sources
    // (YouTube talks/interviews/podcasts), neither of which is a package registry. Total
    // across the whole gateway (this file plus searchWeb/fetchPage/libraryDocs in tools.ts):
    // 9 tool definitions, up from 8 before findVideos.
    academicSearch: buildAcademicSearchTool(ledger, jobId),
    findVideos: buildFindVideosTool(ledger, jobId, onYtdlp),
  }
}
