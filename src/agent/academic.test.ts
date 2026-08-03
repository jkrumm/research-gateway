import { describe, it, expect } from 'bun:test'
import { mapOpenAlexWork, mapPubmedRecord, parsePubmedIds } from './academic.js'

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
})
