// Pure mapping helpers for the `academicSearch` tool (direct-sources.ts): turn the MEASURED
// OpenAlex and PubMed/NCBI response shapes into the tool's compact output. Dependency-free
// (no env/fetch import) so the mapping is unit-testable against fixtures without booting the
// env/LLM import chain — same convention as extract-reddit.ts / site-adapters.ts.

const MAX_AUTHORS = 5

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
