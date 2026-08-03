// Pure helpers for the direct-source tools (direct-sources.ts): argument validators and
// result re-ranking. The validators matter because their inputs are interpolated straight
// into third-party URLs, so anything that could escape its path segment is rejected before
// a request is built.
//
// Dependency-free by design (no project imports) so it is unit-testable without booting
// the env/LLM import chain — same convention as `extract.ts` / `ledger.ts`. That is the
// whole reason these live here rather than next to the tools that use them.

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// Refs may contain slashes (`release/2.0`, `refs/tags/v1`) but must still not traverse.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export function badRepoArg(owner: string, repo: string, ref?: string): string | null {
  if (!NAME_RE.test(owner)) return `invalid owner "${owner}"`
  if (!NAME_RE.test(repo)) return `invalid repo "${repo}"`
  if (ref !== undefined && (!REF_RE.test(ref) || ref.includes('..'))) return `invalid ref "${ref}"`
  return null
}

export function badPath(path: string): string | null {
  if (path.length === 0) return 'path is empty'
  if (path.startsWith('/')) return 'path must be repo-relative (no leading slash)'
  if (path.split('/').some((seg) => seg === '..')) return 'path must not contain ".."'
  return null
}

export function badPackageName(name: string): string | null {
  if (name.length === 0) return 'package name is empty'
  if (/\s/.test(name)) return `invalid package name "${name}"`
  // Scoped npm names are `@scope/name`; nothing else may contain a slash, and no name may
  // traverse or start with a dot.
  if (name.startsWith('.') || name.includes('..')) return `invalid package name "${name}"`
  const parts = name.startsWith('@') ? name.slice(1).split('/') : [name]
  if (parts.length > 2) return `invalid package name "${name}"`
  if (parts.some((p) => p.length === 0 || p.startsWith('.'))) return `invalid package name "${name}"`
  return null
}

// Go's module proxy protocol (proxy.golang.org) requires uppercase letters in a module path
// to be escaped as "!" + the lowercase letter — module paths are case-sensitive but the
// proxy's own cache/filesystem layer is not, so this is how it keeps `Foo` and `foo` distinct
// on disk. MEASURED: `github.com/!masterminds/semver/v3/@latest` returns 200 while the
// unescaped `github.com/Masterminds/semver/v3/@latest` returns 404 — silent breakage, not a
// slow one, if this is missed. Exported standalone so it is unit-testable without the
// env/fetch import chain the tool itself needs.
export function escapeGoModulePath(path: string): string {
  return path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)
}

// Docker Hub repository names are lowercase alphanumeric with `.`, `_`, `-` separators
// between groups, and at most one `/` (namespace/repo) — a registry-prefixed name
// (`quay.io/...`) or anything deeper is out of scope for the Docker Hub API this backs.
// `badPackageName` above is written for language-package names and does not reject a
// `namespace/repo` string or enforce lowercase (both are needed here), so this is a
// dedicated check rather than a weakening of that one.
const DOCKER_COMPONENT_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

export function badDockerName(name: string): string | null {
  if (name.length === 0) return 'docker image name is empty'
  const parts = name.split('/')
  if (parts.length > 2) return `invalid docker image name "${name}" — expected "repo" or "namespace/repo"`
  if (parts.some((p) => !DOCKER_COMPONENT_RE.test(p))) {
    return `invalid docker image name "${name}" — Docker Hub names are lowercase alphanumeric with ., _, - separators`
  }
  return null
}

// A bare name (no slash) means an OFFICIAL image, which Docker Hub itself files under the
// `library` namespace — MEASURED working as `library/postgres`. Assumes `badDockerName`
// already passed; this only shapes an already-valid name.
export function resolveDockerName(name: string): { namespace: string; repo: string; pageUrl: string } {
  const parts = name.split('/')
  if (parts.length === 1) {
    const repo = parts[0]!
    return { namespace: 'library', repo, pageUrl: `https://hub.docker.com/_/${repo}` }
  }
  const [namespace, repo] = parts as [string, string]
  return { namespace, repo, pageUrl: `https://hub.docker.com/r/${namespace}/${repo}` }
}

// npm's own relevance ranking buries the obvious answer: searching "zod schema validation"
// returns `@vee-validate/zod` above `zod`. Re-rank so a package the query NAMES outranks one
// that merely mentions it, keeping the registry's ordering within each tier.
export function rerankByName<T>(query: string, items: T[], nameOf: (item: T) => string): T[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9@/._-]+/)
    .filter((t) => t.length > 1)
  if (tokens.length === 0) return items

  const boost = (raw: string): number => {
    const name = raw.toLowerCase()
    const bare = name.replace(/^@[^/]+\//, '')
    if (tokens.includes(name)) return 3 // the query names this package exactly, scope and all
    if (tokens.includes(bare)) return 2 // a scoped package whose bare name matches: `@vee-validate/zod`
    if (tokens.some((t) => bare.startsWith(t) || t.startsWith(bare))) return 1
    return 0
  }

  return items
    .map((item, index) => ({ item, index, boost: boost(nameOf(item)) }))
    .sort((a, b) => b.boost - a.boost || a.index - b.index)
    .map((x) => x.item)
}
