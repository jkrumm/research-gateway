// Pure mapping helpers for the `academicSearch` tool (direct-sources.ts): turn the MEASURED
// OpenAlex and PubMed/NCBI response shapes into the tool's compact output. Dependency-free
// (no env/fetch import) so the mapping is unit-testable against fixtures without booting the
// env/LLM import chain — same convention as extract-reddit.ts / site-adapters.ts.

const MAX_AUTHORS = 5

// A bare DOI, optionally prefixed `doi:` or a doi.org URL — the three shapes a model routinely
// hands `unpaywall`/CORE's DOI guard. `10.NNNN(N…)/<suffix>` is the DOI syntax itself (4-9
// digits after the `10.`), not something specific to any one registry.
const DOI_RE = /^10\.\d{4,9}\/\S+$/i

/** Strips a `doi:` prefix or a `https://doi.org/`/`https://dx.doi.org/` wrapper and validates what remains. Returns null for anything that is not a DOI at all. */
export function normalizeDoi(input: string): string | null {
  const stripped = input
    .trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  return DOI_RE.test(stripped) ? stripped : null
}

// ── OpenAlex ─────────────────────────────────────────────────────────────────
// Shape measured live against `GET api.openalex.org/works?search=...&select=...`. `select`
// is load-bearing at the call site: the unselected response nests a full abstract inverted
// index and every location per work, which is easily an order of magnitude larger than what
// this tool maps and would eat a worker's context budget for one call.

export interface OpenAlexWork {
  id?: string
  doi?: string
  title?: string
  publication_year?: number
  cited_by_count?: number
  type?: string
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string | null }
  primary_location?: { source?: { display_name?: string } | null; landing_page_url?: string | null } | null
  authorships?: Array<{ author?: { display_name?: string } }>
}

export interface AcademicResult {
  id: string | null
  doi: string | null
  title: string | null
  year: number | null
  citedBy: number | null
  type: string | null
  venue: string | null
  openAccessUrl: string | null
  landingPageUrl: string | null
  authors: string[]
}

export function mapOpenAlexWork(work: OpenAlexWork): AcademicResult {
  return {
    id: work.id ?? null,
    doi: work.doi ?? null,
    title: work.title ?? null,
    year: work.publication_year ?? null,
    citedBy: work.cited_by_count ?? null,
    type: work.type ?? null,
    venue: work.primary_location?.source?.display_name ?? null,
    openAccessUrl: work.open_access?.oa_url ?? null,
    landingPageUrl: work.primary_location?.landing_page_url ?? null,
    authors: (work.authorships ?? [])
      .map((a) => a.author?.display_name)
      .filter((n): n is string => Boolean(n))
      .slice(0, MAX_AUTHORS),
  }
}

// ── PubMed / NCBI eutils ─────────────────────────────────────────────────────
// Two sequential calls: esearch (query -> id list) then esummary (id list -> records). Both
// shapes measured live.

export interface PubmedEsearchResult {
  esearchresult?: { count?: string; idlist?: string[] }
}

/** `count` is a STRING in the esearch response — measured, not a typo carried over here. */
export function parsePubmedIds(json: PubmedEsearchResult): { ids: string[]; totalCount: number } {
  const ids = json.esearchresult?.idlist ?? []
  const parsed = Number(json.esearchresult?.count ?? '0')
  return { ids, totalCount: Number.isFinite(parsed) ? parsed : 0 }
}

export interface PubmedSummaryRecord {
  uid?: string
  pubdate?: string
  source?: string
  fulljournalname?: string
  authors?: Array<{ name?: string; authtype?: string }>
  title?: string
  articleids?: Array<{ idtype?: string; value?: string }>
}

export interface PubmedResult {
  pmid: string
  title: string | null
  journal: string | null
  pubdate: string | null
  authors: string[]
  doi: string | null
  url: string
}

export function mapPubmedRecord(uid: string, record: PubmedSummaryRecord): PubmedResult {
  return {
    pmid: uid,
    title: record.title ?? null,
    // `fulljournalname` is the fuller name esummary carries; `source` is its short-form
    // fallback for the rare record missing the former.
    journal: record.fulljournalname ?? record.source ?? null,
    pubdate: record.pubdate ?? null,
    authors: (record.authors ?? [])
      .map((a) => a.name)
      .filter((n): n is string => Boolean(n))
      .slice(0, MAX_AUTHORS),
    doi: record.articleids?.find((a) => a.idtype === 'doi')?.value ?? null,
    url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
  }
}

// ── arXiv (export.arxiv.org/api/query, Atom XML) ────────────────────────────
// No XML library — small regexes, MEASURED against a live response (`__fixtures__/academic/
// arxiv-idlist.xml`). Atom attribute order is NOT consistent between link tags on the same
// feed (the pdf link is `href rel type title`, the doi link is `rel href title`), so link
// attributes are parsed generically rather than positionally.

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }

/** Standard XML entities only — arXiv's feed carries no CDATA sections (measured). */
function decodeXmlEntities(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp);/g, (_m, name: string) => XML_ENTITIES[name]!)
}

/** Collapses the newlines/indentation Atom wraps multi-line `<title>`/`<summary>` text in. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function parseTagAttrs(tagInner: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([\w:-]+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tagInner))) attrs[m[1]!] = decodeXmlEntities(m[2]!)
  return attrs
}

export interface ArxivEntry {
  /** The Atom entry id — an `arxiv.org/abs/<id>vN` URL. */
  id: string
  title: string | null
  summary: string | null
  published: string | null
  authors: string[]
  /** `link[rel=alternate]` — the `/abs/` landing page, same value as `id` in practice. */
  htmlUrl: string | null
  /** `link[title=pdf]` — sometimes absent (measured: not every entry carries one). */
  pdfUrl: string | null
  doi: string | null
  journalRef: string | null
  primaryCategory: string | null
}

export function parseArxivFeed(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = []
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g
  let entryMatch: RegExpExecArray | null
  while ((entryMatch = entryRe.exec(xml))) {
    const block = entryMatch[1]!
    const id = /<id>([^<]*)<\/id>/.exec(block)?.[1]?.trim()
    if (!id) continue // malformed entry — skip rather than emit a half-populated record

    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(block)
    const summaryMatch = /<summary>([\s\S]*?)<\/summary>/.exec(block)
    const journalRefMatch = /<arxiv:journal_ref>([\s\S]*?)<\/arxiv:journal_ref>/.exec(block)

    const authors: string[] = []
    const authorRe = /<author>\s*<name>([^<]*)<\/name>/g
    let authorMatch: RegExpExecArray | null
    while ((authorMatch = authorRe.exec(block))) authors.push(decodeXmlEntities(authorMatch[1]!.trim()))

    let htmlUrl: string | null = null
    let pdfUrl: string | null = null
    const linkRe = /<link\s+([^>]*?)\/?>/g
    let linkMatch: RegExpExecArray | null
    while ((linkMatch = linkRe.exec(block))) {
      const attrs = parseTagAttrs(linkMatch[1]!)
      if (attrs['rel'] === 'alternate' && attrs['href']) htmlUrl = attrs['href']
      if (attrs['title'] === 'pdf' && attrs['href']) pdfUrl = attrs['href']
    }

    entries.push({
      id,
      title: titleMatch ? collapseWhitespace(decodeXmlEntities(titleMatch[1]!)) : null,
      summary: summaryMatch ? collapseWhitespace(decodeXmlEntities(summaryMatch[1]!)) : null,
      published: /<published>([^<]*)<\/published>/.exec(block)?.[1]?.trim() ?? null,
      authors,
      htmlUrl,
      pdfUrl,
      doi: /<arxiv:doi>([^<]*)<\/arxiv:doi>/.exec(block)?.[1]?.trim() ?? null,
      journalRef: journalRefMatch ? collapseWhitespace(decodeXmlEntities(journalRefMatch[1]!)) : null,
      primaryCategory: /<arxiv:primary_category\s+term="([^"]*)"/.exec(block)?.[1] ?? null,
    })
  }
  return entries
}

// Modern `YYMM.NNNNN[vN]` (2007-present) or old-style `archive-name[.SUBCLASS]/YYMMNNN[vN]`
// (pre-2007, e.g. `physics/0601001`) — the same two shapes site-adapters.ts's arXiv adapter
// rewrites.
const ARXIV_ID_RE = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Za-z]{2})?\/\d{7})(?:v\d+)?$/i

/** True when `query` IS an arXiv id rather than free text — routes to `id_list=` instead of a `search_query=`. */
export function isArxivId(query: string): boolean {
  return ARXIV_ID_RE.test(query.trim())
}

// A bare multi-word `all:` query is an implicit OR in arXiv's search grammar (MEASURED
// 2026-09-23) — explicit `AND` is what "find this specific paper by title words" needs.
export function buildArxivSearchQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `all:${term}`)
    .join(' AND ')
}

// ── Unpaywall (api.unpaywall.org/v2/<doi>) ──────────────────────────────────
// DOI lookup only — MEASURED 2026-09-18: the `/v2/search` endpoint now 410s.

export interface UnpaywallLocation {
  url: string | null
  urlForPdf: string | null
  urlForLandingPage: string | null
  license: string | null
  hostType: string | null
  version: string | null
}

export interface UnpaywallResult {
  doi: string | null
  title: string | null
  year: number | null
  journalName: string | null
  isOa: boolean
  authors: string[]
  bestOaLocation: UnpaywallLocation | null
  /** Up to 3 — MEASURED responses can carry several; the tool caller trims further. */
  oaLocations: UnpaywallLocation[]
}

interface UnpaywallLocationRaw {
  url?: string | null
  url_for_pdf?: string | null
  url_for_landing_page?: string | null
  license?: string | null
  host_type?: string | null
  version?: string | null
}

export interface UnpaywallResponse {
  doi?: string
  title?: string
  year?: number
  journal_name?: string
  is_oa?: boolean
  z_authors?: Array<{ raw_author_name?: string }>
  best_oa_location?: UnpaywallLocationRaw | null
  oa_locations?: UnpaywallLocationRaw[]
}

function mapUnpaywallLocation(loc: UnpaywallLocationRaw): UnpaywallLocation {
  return {
    url: loc.url ?? null,
    urlForPdf: loc.url_for_pdf ?? null,
    urlForLandingPage: loc.url_for_landing_page ?? null,
    license: loc.license ?? null,
    hostType: loc.host_type ?? null,
    version: loc.version ?? null,
  }
}

export function mapUnpaywallResponse(data: UnpaywallResponse): UnpaywallResult {
  return {
    doi: data.doi ?? null,
    title: data.title ?? null,
    year: data.year ?? null,
    journalName: data.journal_name ?? null,
    isOa: data.is_oa ?? false,
    authors: (data.z_authors ?? [])
      .map((a) => a.raw_author_name)
      .filter((n): n is string => Boolean(n))
      .slice(0, MAX_AUTHORS),
    bestOaLocation: data.best_oa_location ? mapUnpaywallLocation(data.best_oa_location) : null,
    oaLocations: (data.oa_locations ?? []).slice(0, 3).map(mapUnpaywallLocation),
  }
}

// ── Crossref (api.crossref.org/works) ───────────────────────────────────────
// `link[].content-type` is unreliable — MEASURED: Copernicus tags its own PDF link
// `unspecified` rather than `application/pdf` — so every link URL is exposed and the "best"
// pick falls back to a `.pdf`-suffixed URL when no link is honestly typed.

export interface CrossrefWork {
  doi: string | null
  title: string | null
  authors: string[]
  year: number | null
  containerTitle: string | null
  /** Crossref's own `URL` field — almost always `https://doi.org/<doi>`. */
  url: string | null
  type: string | null
  /** Every `link[].URL` value, untyped — see the header above for why none is dropped. */
  fullTextLinks: string[]
  /** The best guess at a directly-fetchable full-text URL among `fullTextLinks`, or null. */
  openAccessUrl: string | null
}

interface CrossrefLinkRaw {
  URL?: string
  'content-type'?: string
}
interface CrossrefAuthorRaw {
  given?: string
  family?: string
  name?: string
}
export interface CrossrefWorkRaw {
  DOI?: string
  title?: string[]
  author?: CrossrefAuthorRaw[]
  issued?: { 'date-parts'?: number[][] }
  'container-title'?: string[]
  URL?: string
  type?: string
  link?: CrossrefLinkRaw[]
}

function crossrefAuthorName(a: CrossrefAuthorRaw): string | null {
  if (a.name) return a.name
  const parts = [a.given, a.family].filter((p): p is string => Boolean(p))
  return parts.length > 0 ? parts.join(' ') : null
}

export function mapCrossrefWork(work: CrossrefWorkRaw): CrossrefWork {
  const links = work.link ?? []
  const fullTextLinks = links.map((l) => l.URL).filter((u): u is string => Boolean(u))
  const typedPdf = links.find((l) => l['content-type'] === 'application/pdf')?.URL
  const guessedPdf = fullTextLinks.find((u) => u.toLowerCase().endsWith('.pdf'))
  return {
    doi: work.DOI ?? null,
    title: work.title?.[0] ?? null,
    authors: (work.author ?? [])
      .map(crossrefAuthorName)
      .filter((n): n is string => Boolean(n))
      .slice(0, MAX_AUTHORS),
    year: work.issued?.['date-parts']?.[0]?.[0] ?? null,
    containerTitle: work['container-title']?.[0] ?? null,
    url: work.URL ?? null,
    type: work.type ?? null,
    fullTextLinks,
    openAccessUrl: typedPdf ?? guessedPdf ?? null,
  }
}

// ── CORE (api.core.ac.uk/v3/search/works) ───────────────────────────────────

export interface CoreResult {
  id: string | null
  doi: string | null
  title: string | null
  year: number | null
  authors: string[]
  downloadUrl: string | null
  sourceFulltextUrls: string[]
  publisher: string | null
  journal: string | null
  /** `https://core.ac.uk/works/<id>` — the human landing page, built from `id` (CORE returns no such field itself). */
  landingPageUrl: string | null
}

export interface CoreWorkRaw {
  id?: number
  doi?: string | null
  title?: string
  yearPublished?: number
  authors?: Array<{ name?: string }>
  downloadUrl?: string | null
  sourceFulltextUrls?: string[]
  publisher?: string | null
  journals?: Array<{ title?: string | null }>
}

export function mapCoreWork(work: CoreWorkRaw): CoreResult {
  const id = work.id != null ? String(work.id) : null
  return {
    id,
    doi: work.doi ?? null,
    title: work.title ?? null,
    year: work.yearPublished ?? null,
    authors: (work.authors ?? [])
      .map((a) => a.name)
      .filter((n): n is string => Boolean(n))
      .slice(0, MAX_AUTHORS),
    downloadUrl: work.downloadUrl ?? null,
    sourceFulltextUrls: work.sourceFulltextUrls ?? [],
    publisher: work.publisher ?? null,
    journal: work.journals?.[0]?.title ?? null,
    landingPageUrl: id ? `https://core.ac.uk/works/${id}` : null,
  }
}

// ── Semantic Scholar (api.semanticscholar.org/graph/v1/paper/search) ───────
// Only offered by the tool when `S2_API_KEY` is set — keyless was measured and rejected
// (docs/measurements.md): the very first unauthenticated call from the VPS returned HTTP 429.

export interface SemanticScholarResult {
  paperId: string | null
  title: string | null
  year: number | null
  authors: string[]
  venue: string | null
  doi: string | null
  openAccessPdfUrl: string | null
  url: string | null
  citationCount: number | null
}

export interface S2PaperRaw {
  paperId?: string
  title?: string
  year?: number
  authors?: Array<{ name?: string }>
  venue?: string
  externalIds?: { DOI?: string }
  openAccessPdf?: { url?: string } | null
  url?: string
  citationCount?: number
}

export function mapSemanticScholarPaper(paper: S2PaperRaw): SemanticScholarResult {
  return {
    paperId: paper.paperId ?? null,
    title: paper.title ?? null,
    year: paper.year ?? null,
    authors: (paper.authors ?? [])
      .map((a) => a.name)
      .filter((n): n is string => Boolean(n))
      .slice(0, MAX_AUTHORS),
    venue: paper.venue ?? null,
    doi: paper.externalIds?.DOI ?? null,
    openAccessPdfUrl: paper.openAccessPdf?.url ?? null,
    url: paper.url ?? null,
    citationCount: paper.citationCount ?? null,
  }
}
