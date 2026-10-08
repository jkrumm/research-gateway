import { describe, expect, test } from 'bun:test'
import { isCrossMarketClaim, isMarketSensitiveClaim, marketOfQuery, marketOfUrl } from './market.js'

const DE = { country: 'DE' } as const

describe('marketOfQuery', () => {
  test('one named country is a market', () => {
    expect(marketOfQuery('Was kostet das Storck Rebel in Deutschland?')).toEqual({ country: 'DE' })
    expect(marketOfQuery('price of the Brompton in Germany')).toEqual({ country: 'DE' })
    expect(marketOfQuery('cheapest eMTB available in the UK')).toEqual({ country: 'GB' })
  })
  test('dotted abbreviations', () => {
    expect(marketOfQuery('price of the Rebel in the U.S.')).toEqual({ country: 'US' })
    expect(marketOfQuery('price in the U.K. today')).toEqual({ country: 'GB' })
    expect(marketOfQuery('shipping to the u.s.a. next week')).toEqual({ country: 'US' })
  })
  test('none or several is null', () => {
    expect(marketOfQuery('how does the bun test runner work')).toBeNull()
    expect(marketOfQuery('compare German and French prices')).toBeNull()
  })
})

describe('marketOfUrl', () => {
  test('ccTLD, country subdomain and locale path', () => {
    expect(marketOfUrl('https://www.bike-discount.de/en/x')).toBe('DE')
    expect(marketOfUrl('https://www.specialized.com/au/en/p/1')).toBe('AU')
    expect(marketOfUrl('https://www.specialized.com/en-us/p/1')).toBe('US')
    expect(marketOfUrl('https://www.shop.com/de_DE/p/1')).toBe('DE')
    expect(marketOfUrl('https://shop.co.uk/p')).toBe('GB')
    expect(marketOfUrl('https://au.example.com/p')).toBe('AU')
  })
  test('a bare .com or .org is unknown, not foreign', () => {
    expect(marketOfUrl('https://github.com/oven-sh/bun')).toBeNull()
    expect(marketOfUrl('https://www.example.com/products/1')).toBeNull()
  })
})

describe('isCrossMarketClaim', () => {
  test('issue case: US/AU page backing a German price claim', () => {
    expect(isCrossMarketClaim('The Rebel costs 4,999 EUR', 'https://www.specialized.com/au/en/p/1', DE)).toBe(true)
    expect(isCrossMarketClaim('Price is 4999 €', 'https://www.specialized.com/en-us/p/1', DE)).toBe(true)
  })
  test('same-market page is fine', () => {
    expect(isCrossMarketClaim('Price is 4999 €', 'https://www.bike24.de/p/1', DE)).toBe(false)
  })
  test('unknown-market URL passes unless the claim quotes a foreign currency', () => {
    expect(isCrossMarketClaim('Price is 4999 €', 'https://www.example.com/p/1', DE)).toBe(false)
    expect(isCrossMarketClaim('Price is $5,499', 'https://www.example.com/p/1', DE)).toBe(true)
    expect(isCrossMarketClaim('Price is $5,499', 'https://www.example.com/p/1', { country: 'US' })).toBe(false)
  })
  test('a foreign currency next to the local one still counts', () => {
    expect(isCrossMarketClaim('Price is €4,999 / US$5,499', 'https://www.example.com/p/1', DE)).toBe(true)
    expect(isCrossMarketClaim('Price is 4999 USD', 'https://www.bike24.de/p/1', DE)).toBe(true)
  })
  test('non-price claims are never cross-market', () => {
    expect(isMarketSensitiveClaim('The frame is carbon fibre')).toBe(false)
    expect(isCrossMarketClaim('The frame is carbon fibre', 'https://www.specialized.com/au/en/p/1', DE)).toBe(false)
  })
})
