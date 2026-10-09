import { describe, it, expect } from 'bun:test'
import {
  enrichThinText,
  extractStructuredData,
  isThinForBody,
  STRUCTURED_DATA_CAP,
  STRUCTURED_DATA_HEADING,
} from './structured-data.js'
import { extractText } from './html-parse.js'

const PRODUCT = {
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: 'Endurace CF 7',
  sku: '3501',
  brand: { '@type': 'Brand', name: 'Canyon' },
  description: '<p>Endurance road bike with <b>Shimano 105</b> groupset.</p>',
  image: ['https://example.com/a.jpg'],
  additionalProperty: [
    { '@type': 'PropertyValue', name: 'Groupset', value: 'Shimano 105 Di2' },
    { '@type': 'PropertyValue', name: 'Weight', value: '8.4', unitText: 'kg' },
  ],
  offers: {
    '@type': 'Offer',
    price: '2199.00',
    priceCurrency: 'EUR',
    availability: 'https://schema.org/InStock',
  },
}

const ld = (json: unknown): string => `<script type="application/ld+json">${typeof json === 'string' ? json : JSON.stringify(json)}</script>`

// A Canyon-shaped page: a short article Readability keeps, a mountain of inline script it drops,
// and the product data only in JSON-LD.
const article = `<article><h1>Endurace CF 7</h1><p>${'Comfortable, fast and built for long days in the saddle. '.repeat(8)}</p></article>`
const filler = Array.from({ length: 400 }, (_, i) => `<script>window.__s${i}="${'x'.repeat(150)}"</script>`).join('')
const bigPage = (head: string): string => `<html><head><title>Bike</title>${head}</head><body>${article}${filler}</body></html>`

describe('isThinForBody', () => {
  it('is thin for a big body with a sliver of text', () => {
    expect(isThinForBody({ bodyChars: 611_000, textChars: 1_200 })).toBe(true)
  })
  it('never judges a small body, however short its text', () => {
    expect(isThinForBody({ bodyChars: 8_000, textChars: 250 })).toBe(false)
    expect(isThinForBody({ bodyChars: 50_000, textChars: 250 })).toBe(false)
  })
  it('accepts a big body whose text is substantial', () => {
    expect(isThinForBody({ bodyChars: 611_000, textChars: 3_000 })).toBe(false)
  })
  it('scales the bar with a mid-size body (3% share)', () => {
    expect(isThinForBody({ bodyChars: 60_000, textChars: 1_700 })).toBe(true)
    expect(isThinForBody({ bodyChars: 60_000, textChars: 1_900 })).toBe(false)
  })
})

describe('extractStructuredData', () => {
  it('flattens Product + Offer + PropertyValue into key: value lines', () => {
    const out = extractStructuredData(ld(PRODUCT))
    expect(out).toContain('[Product]')
    expect(out).toContain('name: Endurace CF 7')
    expect(out).toContain('sku: 3501')
    expect(out).toContain('brand.name: Canyon')
    expect(out).toContain('description: Endurance road bike with Shimano 105 groupset.')
    expect(out).toContain('Groupset: Shimano 105 Di2')
    expect(out).toContain('Weight: 8.4 kg')
    expect(out).toContain('offers.price: 2199.00')
    expect(out).toContain('offers.priceCurrency: EUR')
    expect(out).toContain('offers.availability: https://schema.org/InStock')
    expect(out).not.toContain('a.jpg')
  })

  it('reads @graph nodes, top-level arrays, and drops site chrome', () => {
    const out = extractStructuredData(
      ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite', name: 'Shop' }, { '@type': 'BreadcrumbList', itemListElement: [] }, PRODUCT] }) +
        ld([{ '@type': 'AggregateOffer', lowPrice: '99', highPrice: '149', priceCurrency: 'EUR' }]),
    )
    expect(out).toContain('offers.price: 2199.00')
    expect(out).toContain('[AggregateOffer]')
    expect(out).toContain('lowPrice: 99')
    expect(out).not.toContain('Shop')
  })

  it('numbers the elements of an ItemList', () => {
    const out = extractStructuredData(
      ld({
        '@type': 'ItemList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, item: { '@type': 'Product', name: 'Bike A', offers: { price: '1000' } } },
          { '@type': 'ListItem', position: 2, item: { '@type': 'Product', name: 'Bike B', offers: { price: '2000' } } },
        ],
      }),
    )
    expect(out).toContain('itemListElement[0].item.name: Bike A')
    expect(out).toContain('itemListElement[1].item.offers.price: 2000')
  })

  it('skips invalid JSON blocks and keeps the valid ones', () => {
    const out = extractStructuredData(ld('{"@type": "Product", "name": ') + ld(PRODUCT))
    expect(out).toContain('offers.price: 2199.00')
  })

  it('returns an empty string when there is nothing usable', () => {
    expect(extractStructuredData('<html><body>hi</body></html>')).toBe('')
    expect(extractStructuredData(ld('not json'))).toBe('')
    expect(extractStructuredData(ld({ '@type': 'WebSite', name: 'Shop' }))).toBe('')
  })

  it('bounds the output at a line boundary', () => {
    const many = { '@type': 'ItemList', itemListElement: Array.from({ length: 50 }, (_, i) => ({ name: `Product ${i} ${'y'.repeat(300)}` })) }
    const out = extractStructuredData(ld(many))
    expect(out.length).toBeLessThanOrEqual(STRUCTURED_DATA_CAP)
    expect(out.split('\n').every((l) => l.startsWith('[') || l.includes(': '))).toBe(true)
  })
})

describe('enrichThinText', () => {
  const text = 'Short Readability text.'

  it('appends the structured section to a thin reading of a big body', () => {
    const r = enrichThinText({ body: bigPage(ld(PRODUCT)), text })
    expect(r.thin).toBe(true)
    expect(r.structured).toBe(true)
    expect(r.text).toStartWith(text)
    expect(r.text).toContain(STRUCTURED_DATA_HEADING)
    expect(r.text).toContain('offers.price: 2199.00')
  })

  it('reports thin without structured data when the page has none', () => {
    const r = enrichThinText({ body: bigPage(''), text })
    expect(r).toEqual({ text, thin: true, structured: false })
  })

  it('leaves a small page untouched even when it carries JSON-LD', () => {
    const body = `<html><head>${ld(PRODUCT)}</head><body>${article}</body></html>`
    expect(enrichThinText({ body, text })).toEqual({ text, thin: false, structured: false })
  })

  it('turns a null reading into the structured section alone', () => {
    const r = enrichThinText({ body: bigPage(ld(PRODUCT)), text: null })
    expect(r.text).toStartWith(STRUCTURED_DATA_HEADING)
  })
})

describe('extractText (parse worker)', () => {
  it('delivers the price and specs a Readability reading of a big shop page drops', async () => {
    const r = await extractText('https://203.0.113.20/bike', bigPage(ld(PRODUCT)))
    expect(r.via).toBe('readability')
    expect(r.thin).toBe(true)
    expect(r.structured).toBe(true)
    expect(r.text).toContain('Comfortable, fast and built')
    expect(r.text).toContain('offers.price: 2199.00')
    expect(r.text).toContain('Groupset: Shimano 105 Di2')
  })

  it('flags a big page with no structured data as thin and unenriched', async () => {
    const r = await extractText('https://203.0.113.20/bike', bigPage(''))
    expect(r.thin).toBe(true)
    expect(r.structured).toBe(false)
    expect(r.text).not.toContain(STRUCTURED_DATA_HEADING)
  })

  it('leaves a small page alone', async () => {
    const r = await extractText('https://203.0.113.20/bike', `<html><body>${article}</body></html>`)
    expect(r.thin).toBe(false)
    expect(r.structured).toBe(false)
  })
})
