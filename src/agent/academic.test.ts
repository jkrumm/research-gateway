import { describe, it, expect } from 'bun:test'
import {
  mapOpenAlexWork,
  mapPubmedRecord,
  parsePubmedIds,
  parseArxivFeed,
  isArxivId,
  buildArxivSearchQuery,
  mapUnpaywallResponse,
  mapCrossrefWork,
  mapCoreWork,
  mapSemanticScholarPaper,
  normalizeDoi,
} from './academic.js'

const FIXTURES = `${import.meta.dir}/__fixtures__/academic`
const readFixture = (name: string) => Bun.file(`${FIXTURES}/${name}`).text()

describe('mapOpenAlexWork', () => {
  // Measured shape, MEASURED live against api.openalex.org/works?search=retrieval+augmented+generation.
  it('maps the full measured shape, trimming authors to the first 5', () => {
    const work = {
      id: 'https://openalex.org/W4389984066',
      doi: 'https://doi.org/10.48550/arxiv.2312.10997',
      title: 'Retrieval-Augmented Generation for Large Language Models: A Survey',
      publication_year: 2023,
      cited_by_count: 691,
      type: 'preprint',
      open_access: { is_oa: true, oa_status: 'green', oa_url: 'https://arxiv.org/pdf/2312.10997' },
      primary_location: {
        source: { display_name: 'arXiv (Cornell University)' },
        landing_page_url: 'http://arxiv.org/abs/2312.10997',
      },
      authorships: [
        { author: { display_name: 'Yunfan Gao' } },
        { author: { display_name: 'Yun Xiong' } },
        { author: { display_name: 'Xinyu Gao' } },
        { author: { display_name: 'Kangxiang Jia' } },
        { author: { display_name: 'Jinliu Pan' } },
        { author: { display_name: 'Yuxi Bi' } },
      ],
    }

    expect(mapOpenAlexWork(work)).toEqual({
      id: 'https://openalex.org/W4389984066',
      doi: 'https://doi.org/10.48550/arxiv.2312.10997',
      title: 'Retrieval-Augmented Generation for Large Language Models: A Survey',
      year: 2023,
      citedBy: 691,
      type: 'preprint',
      venue: 'arXiv (Cornell University)',
      openAccessUrl: 'https://arxiv.org/pdf/2312.10997',
      landingPageUrl: 'http://arxiv.org/abs/2312.10997',
      authors: ['Yunfan Gao', 'Yun Xiong', 'Xinyu Gao', 'Kangxiang Jia', 'Jinliu Pan'],
    })
  })

  it('handles a closed-access work with a null oa_url', () => {
    const work = {
      id: 'https://openalex.org/W1',
      title: 'A closed-access paper',
      open_access: { is_oa: false, oa_status: 'closed', oa_url: null },
      primary_location: { source: { display_name: 'Some Journal' }, landing_page_url: 'https://example.com/paper' },
      authorships: [{ author: { display_name: 'Someone' } }],
    }

    const mapped = mapOpenAlexWork(work)
    expect(mapped.openAccessUrl).toBeNull()
    expect(mapped.venue).toBe('Some Journal')
  })

  it('handles a work with no primary_location and no authorships at all', () => {
    const work = { id: 'https://openalex.org/W2', title: 'Sparse record' }

    expect(mapOpenAlexWork(work)).toEqual({
      id: 'https://openalex.org/W2',
      doi: null,
      title: 'Sparse record',
      year: null,
      citedBy: null,
      type: null,
      venue: null,
      openAccessUrl: null,
      landingPageUrl: null,
      authors: [],
    })
  })
})

describe('parsePubmedIds', () => {
  it('parses the STRING count and the id list', () => {
    expect(parsePubmedIds({ esearchresult: { count: '3413', idlist: ['42541388', '42541111'] } })).toEqual({
      ids: ['42541388', '42541111'],
      totalCount: 3413,
    })
  })

  it('returns an empty id list with its total count when there are no hits', () => {
    expect(parsePubmedIds({ esearchresult: { count: '0', idlist: [] } })).toEqual({ ids: [], totalCount: 0 })
  })

  it('is total against a missing esearchresult', () => {
    expect(parsePubmedIds({})).toEqual({ ids: [], totalCount: 0 })
  })

  it('falls back totalCount to 0 for a non-numeric count', () => {
    expect(parsePubmedIds({ esearchresult: { count: 'N/A', idlist: [] } })).toEqual({ ids: [], totalCount: 0 })
  })
})

describe('mapPubmedRecord', () => {
  // Measured shape, MEASURED live against esummary.fcgi for a PubMed id.
  it('maps title, journal, authors and the doi found among articleids', () => {
    const record = {
      uid: '42541388',
      pubdate: '2026 Jul',
      source: 'J Some Abbrev',
      fulljournalname: 'Journal of Some Full Name',
      authors: [
        { name: 'Doe J', authtype: 'Author' },
        { name: 'Smith A', authtype: 'Author' },
      ],
      title: 'A biomedical finding',
      articleids: [
        { idtype: 'pubmed', value: '42541388' },
        { idtype: 'doi', value: '10.1234/example.doi' },
      ],
    }

    expect(mapPubmedRecord('42541388', record)).toEqual({
      pmid: '42541388',
      title: 'A biomedical finding',
      journal: 'Journal of Some Full Name',
      pubdate: '2026 Jul',
      authors: ['Doe J', 'Smith A'],
      doi: '10.1234/example.doi',
      url: 'https://pubmed.ncbi.nlm.nih.gov/42541388/',
    })
  })

  it('falls back to `source` when fulljournalname is absent, and null doi when none is listed', () => {
    const record = { title: 'Older record', source: 'Short J Name', articleids: [{ idtype: 'pubmed', value: '1' }] }

    const mapped = mapPubmedRecord('1', record)
    expect(mapped.journal).toBe('Short J Name')
    expect(mapped.doi).toBeNull()
  })

  it('trims authors to the first 5 when more than 5 are listed', () => {
    const record = {
      title: 'A multi-author study',
      fulljournalname: 'Journal of Many Authors',
      authors: [
        { name: 'Doe J', authtype: 'Author' },
        { name: 'Smith A', authtype: 'Author' },
        { name: 'Lee K', authtype: 'Author' },
        { name: 'Patel R', authtype: 'Author' },
        { name: 'Garcia M', authtype: 'Author' },
        { name: 'Kim S', authtype: 'Author' },
      ],
      articleids: [{ idtype: 'pubmed', value: '2' }],
    }

    const mapped = mapPubmedRecord('2', record)
    expect(mapped.authors).toEqual(['Doe J', 'Smith A', 'Lee K', 'Patel R', 'Garcia M'])
  })
})

describe('parseArxivFeed', () => {
  it('parses a live id_list=<id> response, incl. mismatched link attribute order', async () => {
    const xml = await readFixture('arxiv-idlist.xml')
    const entries = parseArxivFeed(xml)

    expect(entries).toHaveLength(1)
    const e = entries[0]!
    expect(e.id).toBe('http://arxiv.org/abs/1511.02001v1')
    expect(e.title).toBe('Probabilistic wind speed forecasting on a grid based on ensemble model output statistics')
    expect(e.published).toBe('2015-11-06T08:11:04Z')
    expect(e.authors).toEqual(['Michael Scheuerer', 'David Möller'])
    // The two <link> tags in this fixture carry their attributes in DIFFERENT orders
    // (`href rel type title` for the pdf link, `rel href title` for the doi link) — this is
    // the case that breaks a positional (non-attribute-aware) parse.
    expect(e.htmlUrl).toBe('https://arxiv.org/abs/1511.02001v1')
    expect(e.pdfUrl).toBe('https://arxiv.org/pdf/1511.02001v1')
    expect(e.doi).toBe('10.1214/15-AOAS843')
    expect(e.journalRef).toBe('Annals of Applied Statistics 2015, Vol. 9, No. 3, 1328-1349')
    expect(e.primaryCategory).toBe('stat.AP')
    expect(e.summary).toContain('Probabilistic forecasts of wind speed are important')
  })

  it('returns an empty array for a feed with no entries', () => {
    const empty = `<feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults></feed>`
    expect(parseArxivFeed(empty)).toEqual([])
  })

  it('decodes standard XML entities in title/summary text', () => {
    const xml = `<feed><entry><id>http://arxiv.org/abs/1</id><title>A &amp; B &lt;test&gt;</title></entry></feed>`
    expect(parseArxivFeed(xml)[0]!.title).toBe('A & B <test>')
  })
})

describe('isArxivId / buildArxivSearchQuery', () => {
  it('recognises modern ids, with and without a version suffix', () => {
    expect(isArxivId('2309.04452')).toBe(true)
    expect(isArxivId('2309.04452v2')).toBe(true)
  })

  it('recognises the old-style archive/id form', () => {
    expect(isArxivId('physics/0601001')).toBe(true)
    expect(isArxivId('physics/0601001v1')).toBe(true)
  })

  it('rejects free-text queries', () => {
    expect(isArxivId('EMOS quantile regression forests wind speed')).toBe(false)
    expect(isArxivId('retrieval augmented generation')).toBe(false)
  })

  it('joins multi-word queries with explicit AND, not a bare space', () => {
    // MEASURED: a bare `all:` multi-term query is an implicit OR in arXiv's grammar.
    expect(buildArxivSearchQuery('quantile regression forests')).toBe('all:quantile AND all:regression AND all:forests')
  })

  it('handles a single-word query with no AND at all', () => {
    expect(buildArxivSearchQuery('EMOS')).toBe('all:EMOS')
  })
})

describe('mapUnpaywallResponse', () => {
  it('maps a live DOI lookup, incl. the best/oa location split', async () => {
    const data = JSON.parse(await readFixture('unpaywall-copernicus.json'))
    const mapped = mapUnpaywallResponse(data)

    expect(mapped.doi).toBe('10.5194/npg-30-503-2023')
    expect(mapped.title).toBe('Robust weather-adaptive post-processing using model output statistics random forests')
    expect(mapped.isOa).toBe(true)
    expect(mapped.bestOaLocation).toEqual({
      url: 'https://npg.copernicus.org/articles/30/503/2023/npg-30-503-2023.pdf',
      urlForPdf: 'https://npg.copernicus.org/articles/30/503/2023/npg-30-503-2023.pdf',
      urlForLandingPage: 'https://doi.org/10.5194/npg-30-503-2023',
      license: 'cc-by',
      hostType: 'publisher',
      version: 'publishedVersion',
    })
    expect(mapped.oaLocations).toHaveLength(2)
    expect(mapped.authors[0]).toBe('Thomas Muschinski')
  })

  it('caps oaLocations at 3 even when the response carries more', () => {
    const loc = { url: 'https://x.test/a.pdf' }
    const data = { doi: '10.1/x', oa_locations: [loc, loc, loc, loc, loc] }
    expect(mapUnpaywallResponse(data).oaLocations).toHaveLength(3)
  })

  it('handles a closed-access record with no best_oa_location', () => {
    const mapped = mapUnpaywallResponse({ doi: '10.1/closed', is_oa: false })
    expect(mapped.bestOaLocation).toBeNull()
    expect(mapped.oaLocations).toEqual([])
  })
})

describe('mapCrossrefWork', () => {
  it('maps a live single-work response', async () => {
    const raw = JSON.parse(await readFixture('crossref-copernicus-single.json'))
    const mapped = mapCrossrefWork(raw.message)

    expect(mapped.doi).toBe('10.5194/npg-30-503-2023')
    expect(mapped.title).toBe('Robust weather-adaptive post-processing using model output statistics random forests')
    expect(mapped.authors[0]).toBe('Thomas Muschinski')
    expect(mapped.year).toBe(2023)
    expect(mapped.containerTitle).toBe('Nonlinear Processes in Geophysics')
    expect(mapped.url).toBe('https://doi.org/10.5194/npg-30-503-2023')
    expect(mapped.type).toBe('journal-article')
  })

  it("picks the PDF link even when Copernicus tags it content-type 'unspecified'", async () => {
    // MEASURED: Copernicus's own link carries `content-type: unspecified`, not
    // `application/pdf` — the mapper falls back to the URL's `.pdf` suffix.
    const raw = JSON.parse(await readFixture('crossref-copernicus-single.json'))
    const mapped = mapCrossrefWork(raw.message)

    expect(mapped.fullTextLinks).toContain('https://npg.copernicus.org/articles/30/503/2023/npg-30-503-2023.pdf')
    expect(mapped.openAccessUrl).toBe('https://npg.copernicus.org/articles/30/503/2023/npg-30-503-2023.pdf')
  })

  it('prefers a link honestly typed application/pdf over a suffix guess', () => {
    const mapped = mapCrossrefWork({
      DOI: '10.1/x',
      link: [
        { URL: 'https://x.test/landing', 'content-type': 'text/html' },
        { URL: 'https://x.test/fulltext', 'content-type': 'application/pdf' },
      ],
    })
    expect(mapped.openAccessUrl).toBe('https://x.test/fulltext')
  })

  it('falls back to author given+family when name is absent, and null when no link is a pdf', () => {
    const mapped = mapCrossrefWork({
      DOI: '10.1/y',
      author: [{ given: 'Ada', family: 'Lovelace' }],
      link: [{ URL: 'https://x.test/landing', 'content-type': 'text/html' }],
    })
    expect(mapped.authors).toEqual(['Ada Lovelace'])
    expect(mapped.openAccessUrl).toBeNull()
  })
})

describe('mapCoreWork', () => {
  it('maps a live search result, building the landing page from id', async () => {
    const raw = JSON.parse(await readFixture('core-noauth-quoted.json'))
    const mapped = mapCoreWork(raw.results[0])

    expect(mapped.id).toBe('14109412')
    expect(mapped.doi).toBe('10.1007/s00703-016-0467-8')
    expect(mapped.title).toBe('Bivariate ensemble model output statistics approach for joint forecasting of wind speed and temperature')
    expect(mapped.year).toBe(2017)
    expect(mapped.downloadUrl).toBe('https://core.ac.uk/download/95353184.pdf')
    expect(mapped.sourceFulltextUrls).toEqual(['https://core.ac.uk/download/95353184.pdf'])
    expect(mapped.publisher).toBe('Springer')
    expect(mapped.landingPageUrl).toBe('https://core.ac.uk/works/14109412')
  })

  it('is null-safe on a sparse record with no id at all', () => {
    const mapped = mapCoreWork({ title: 'Sparse' })
    expect(mapped.id).toBeNull()
    expect(mapped.landingPageUrl).toBeNull()
    expect(mapped.authors).toEqual([])
  })
})

describe('normalizeDoi', () => {
  it('accepts a bare DOI', () => {
    expect(normalizeDoi('10.5194/npg-30-503-2023')).toBe('10.5194/npg-30-503-2023')
  })

  it('strips a doi: prefix', () => {
    expect(normalizeDoi('doi:10.5194/npg-30-503-2023')).toBe('10.5194/npg-30-503-2023')
  })

  it('strips a doi.org URL, with or without dx.', () => {
    expect(normalizeDoi('https://doi.org/10.5194/npg-30-503-2023')).toBe('10.5194/npg-30-503-2023')
    expect(normalizeDoi('http://dx.doi.org/10.5194/npg-30-503-2023')).toBe('10.5194/npg-30-503-2023')
  })

  it('rejects anything that is not a DOI', () => {
    expect(normalizeDoi('EMOS quantile regression forests')).toBeNull()
    expect(normalizeDoi('2309.04452')).toBeNull()
  })
})

describe('mapSemanticScholarPaper', () => {
  // No successful (non-429) live fixture exists — keyless S2 was measured 429 on every call
  // (docs/measurements.md); this asserts against the documented field shape instead.
  it('maps the documented graph/v1/paper/search shape', () => {
    const mapped = mapSemanticScholarPaper({
      paperId: 'abc123',
      title: 'A Semantic Scholar paper',
      year: 2022,
      authors: [{ name: 'Jane Doe' }],
      venue: 'NeurIPS',
      externalIds: { DOI: '10.1/s2' },
      openAccessPdf: { url: 'https://x.test/s2.pdf' },
      url: 'https://www.semanticscholar.org/paper/abc123',
      citationCount: 42,
    })

    expect(mapped).toEqual({
      paperId: 'abc123',
      title: 'A Semantic Scholar paper',
      year: 2022,
      authors: ['Jane Doe'],
      venue: 'NeurIPS',
      doi: '10.1/s2',
      openAccessPdfUrl: 'https://x.test/s2.pdf',
      url: 'https://www.semanticscholar.org/paper/abc123',
      citationCount: 42,
    })
  })

  it('is null-safe on a sparse record', () => {
    const mapped = mapSemanticScholarPaper({ title: 'Sparse' })
    expect(mapped.doi).toBeNull()
    expect(mapped.openAccessPdfUrl).toBeNull()
    expect(mapped.authors).toEqual([])
  })
})
