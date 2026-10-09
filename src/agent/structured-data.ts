// JSON-LD (`<script type="application/ld+json">`) as a rescue for pages whose visible text
// Readability barely keeps. A shop's product page is a 600 KB HTML document whose price, SKU and
// spec list live in a Product/Offer block while Readability keeps ~1 KB of marketing copy — that
// clears `MIN_USABLE_CHARS`, so no later stage ever ran and the worker got neither price nor spec
// (canyon.com, 25 pages in one job). When the kept text is a sliver of a big body, the structured
// data is flattened into `key: value` lines and appended to what is delivered; with none to
// append, the caller falls through to the rendering steps instead of accepting the sliver.
//
// The ledger records exactly the text `ctx.done` delivers, so the appended section is what the
// number check sees — there is no side channel. Pure string work, no linkedom: runs inside the
// parse worker (parse-worker.ts) right where Readability's text is produced.
//
// Dependency-free by design (no env/log/fetch import) — same convention as ledger/extract.

// Both must hold for "thin": a small page with short text is legitimate, and a big page whose
// text is 3k+ chars has delivered real content however large its markup is. 3,000 chars is the
// floor under which a product page carries no specs; 3% of the body keeps a 50-100 KB page from
// being judged against a bar its own size cannot reach.
export const MIN_BODY_CHARS = 50_000
export const THIN_TEXT_CHARS = 3_000
export const THIN_TEXT_SHARE = 0.03

export const STRUCTURED_DATA_CAP = 6_000
const MAX_BLOCKS = 20
const MAX_VALUE_CHARS = 400
const MAX_ARRAY_ITEMS = 50
const MAX_DEPTH = 6
export const STRUCTURED_DATA_HEADING = '## Structured data (JSON-LD)'

const LD_JSON_BLOCK = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi

// Navigation and site chrome — present on every page, never the answer.
const NOISE_TYPES = new Set(['BreadcrumbList', 'WebSite', 'Organization', 'Corporation', 'SiteNavigationElement', 'ImageObject', 'SearchAction'])
const SKIP_KEYS = new Set([
  'image', 'logo', 'thumbnailUrl', 'sameAs', 'potentialAction', 'mainEntityOfPage', 'breadcrumb',
  'isPartOf', 'primaryImageOfPage', 'publisher',
])

/** Whether Readability kept a sliver of a big body. Pure — the decision the rest keys on. */
export function isThinForBody({ bodyChars, textChars }: { bodyChars: number; textChars: number }): boolean {
  return bodyChars > MIN_BODY_CHARS && textChars < THIN_TEXT_CHARS && textChars < bodyChars * THIN_TEXT_SHARE
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node['@type']
  if (typeof t === 'string') return [t]
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : []
}

function scalar(v: unknown): string | null {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v !== 'string') return null
  const s = v.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS)}…` : s
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Generic flatten rather than one renderer per schema.org type: Product/Offer/AggregateOffer/
// ItemList/ProductGroup/Vehicle/... all read as `path: value` and a type table would rot. A
// PropertyValue is the one shape worth special-casing — `name: value` is the spec line itself.
function flatten(value: unknown, path: string, out: string[], depth: number): void {
  if (depth > MAX_DEPTH || out.length > 500) return
  const s = scalar(value)
  if (s !== null) {
    out.push(path ? `${path}: ${s}` : s)
    return
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS)
    const scalars = items.map(scalar)
    if (scalars.every((x) => x !== null)) {
      if (path && scalars.length) out.push(`${path}: ${scalars.join(', ')}`)
      return
    }
    items.forEach((item, i) => flatten(item, items.length > 1 && path ? `${path}[${i}]` : path, out, depth + 1))
    return
  }
  if (!isRecord(value)) return
  if (typesOf(value).includes('PropertyValue')) {
    const name = scalar(value['name'])
    const val = scalar(value['value'])
    const unit = scalar(value['unitText'])
    if (name && val) {
      out.push(`${name}: ${val}${unit ? ` ${unit}` : ''}`)
      return
    }
  }
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('@') || SKIP_KEYS.has(k)) continue
    flatten(v, path ? `${path}.${k}` : k, out, depth + 1)
  }
}

// A top-level array, or an object whose `@graph` holds the real nodes, both reduce to a flat
// list of root nodes.
function rootsOf(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed.flatMap(rootsOf)
  if (!isRecord(parsed)) return []
  return Array.isArray(parsed['@graph']) ? rootsOf(parsed['@graph']) : [parsed]
}

/**
 * Every JSON-LD block in `html` as readable `key: value` lines, one `[Type]` group per node,
 * capped at STRUCTURED_DATA_CAP. Invalid JSON blocks are skipped, never thrown. `''` when the
 * page carries nothing usable.
 */
export function extractStructuredData(html: string): string {
  const groups: string[] = []
  const seen = new Set<string>()
  let blocks = 0
  for (const m of html.matchAll(LD_JSON_BLOCK)) {
    if (++blocks > MAX_BLOCKS) break
    let parsed: unknown
    try {
      parsed = JSON.parse((m[1] ?? '').trim())
    } catch {
      continue
    }
    for (const node of rootsOf(parsed)) {
      const types = typesOf(node)
      if (types.length && types.every((t) => NOISE_TYPES.has(t))) continue
      const lines: string[] = []
      flatten(node, '', lines, 0)
      if (!lines.length) continue
      const group = `[${types.join(', ') || 'Thing'}]\n${lines.join('\n')}`
      if (seen.has(group)) continue
      seen.add(group)
      groups.push(group)
    }
  }
  const joined = groups.join('\n\n')
  if (joined.length <= STRUCTURED_DATA_CAP) return joined
  // Cut at a line boundary so a truncated value never reads as a complete one.
  const cut = joined.slice(0, STRUCTURED_DATA_CAP)
  return cut.slice(0, Math.max(cut.lastIndexOf('\n'), 0))
}

export interface EnrichedText {
  text: string | null
  /** Readability's own text was a sliver of a big body — measured BEFORE anything was appended. */
  thin: boolean
  /** The structured-data section was appended to `text`. */
  structured: boolean
}

/**
 * Appends the page's structured data to a thin Readability reading. A page that is not thin is
 * returned untouched — the scan only runs when Readability visibly lost the page.
 */
export function enrichThinText({ body, text }: { body: string; text: string | null }): EnrichedText {
  const thin = isThinForBody({ bodyChars: body.length, textChars: text?.length ?? 0 })
  if (!thin) return { text, thin, structured: false }
  const data = extractStructuredData(body)
  if (!data) return { text, thin, structured: false }
  const section = `${STRUCTURED_DATA_HEADING}\n${data}`
  return { text: text ? `${text}\n\n${section}` : section, thin, structured: true }
}
