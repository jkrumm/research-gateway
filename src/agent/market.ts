// Market (country) awareness for price and availability claims. Env-free, tested.
//
// Measured 2026-10-08 (job b9b24998): US and AU shop pages backed German-market price claims at
// `high`. A price is a fact about one market; a page for another market proves nothing about
// this one. Enforced in code at the job boundary (ground.ts), never by prompt alone — the
// worker prompt asks for local pages, this is what holds when the model does not comply.
//
// Conservative on every side: a market is only inferred when the query names exactly one
// country, a URL only has a market when its ccTLD, locale path or country subdomain says so
// (a bare .com is unknown, never foreign), and the only consequence is a `medium` ceiling.

export type Country = 'DE' | 'AT' | 'CH' | 'FR' | 'NL' | 'ES' | 'IT' | 'GB' | 'US' | 'CA' | 'AU'
type Currency = 'EUR' | 'CHF' | 'GBP' | 'USD' | 'CAD' | 'AUD'

export interface Market {
  country: Country
}

const CURRENCY_OF: Record<Country, Currency> = {
  DE: 'EUR', AT: 'EUR', FR: 'EUR', NL: 'EUR', ES: 'EUR', IT: 'EUR',
  CH: 'CHF', GB: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD',
}

const QUERY_WORDS: ReadonlyArray<[Country, RegExp]> = [
  ['DE', /\b(?:germany|german(?:y'?s)?|deutschland|deutsch(?:e[rsn]?)?|auf deutsch|amazon\.de)\b/i],
  ['AT', /\b(?:austria|austrian|österreich|oesterreich)\b/i],
  ['CH', /\b(?:switzerland|swiss|schweiz|suisse)\b/i],
  ['FR', /\b(?:france|french|frankreich|français)\b/i],
  ['NL', /\b(?:netherlands|dutch|niederlande|holland)\b/i],
  ['ES', /\b(?:spain|spanish|spanien|españa)\b/i],
  ['IT', /\b(?:italy|italian|italien|italia)\b/i],
  ['GB', /\b(?:uk|united kingdom|britain|british|england|großbritannien)\b|(?<![a-z])u\.k\.?(?![a-z])/i],
  ['US', /\b(?:usa|united states|american|us market)\b|(?<![a-z])u\.s\.(?:a\.)?(?![a-z])/i],
  ['CA', /\b(?:canada|canadian|kanada)\b/i],
  ['AU', /\b(?:australia|australian|australien)\b/i],
]

/** The one country a query is about, or null when it names none or several. */
export function marketOfQuery(query: string): Market | null {
  const hits = QUERY_WORDS.filter(([, re]) => re.test(query)).map(([country]) => country)
  const [only] = hits
  return hits.length === 1 && only ? { country: only } : null
}

const COUNTRY_BY_CODE: Record<string, Country> = {
  de: 'DE', at: 'AT', ch: 'CH', fr: 'FR', nl: 'NL', es: 'ES', it: 'IT',
  uk: 'GB', gb: 'GB', us: 'US', ca: 'CA', au: 'AU',
}

/** The market a URL belongs to, from its ccTLD, a country subdomain or a locale path
 *  (`/en-au/`, `/de_DE/`, `/us/`). null when it says nothing — a bare .com is unknown. */
export function marketOfUrl(raw: string): Country | null {
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  const labels = url.hostname.toLowerCase().split('.')
  const tld = labels.at(-1) ?? ''
  const cc = COUNTRY_BY_CODE[tld]
  if (cc && labels.length >= 2) return cc

  const first = labels.length >= 3 ? (labels[0] ?? '') : ''
  const sub = COUNTRY_BY_CODE[first]
  if (sub) return sub

  const [seg] = url.pathname.toLowerCase().split('/').filter(Boolean)
  if (!seg) return null
  const locale = /^[a-z]{2}[-_]([a-z]{2})$/.exec(seg)
  return COUNTRY_BY_CODE[locale?.[1] ?? seg] ?? null
}

const PRICE_OR_STOCK_RE =
  /[€£$]|\b(?:eur|usd|gbp|chf|aud|cad)\b|\b(?:price[sd]?|pricing|cost[s]?|msrp|rrp|uvp|preis(?:e)?|kostet|in stock|out of stock|available|availability|verfügbar|lieferbar|ships?|shipping|versand|on sale)\b/i

/** A claim about what something costs or whether it can be bought — the kind of fact that
 *  differs by market. */
export function isMarketSensitiveClaim(claim: string): boolean {
  return PRICE_OR_STOCK_RE.test(claim)
}

// Currencies a claim states. A bare `$` is ambiguous between USD/AUD/CAD, so it matches any of them.
function currenciesIn(claim: string): { named: Set<Currency>; bareDollar: boolean } {
  const named = new Set<Currency>()
  if (/€|\beur\b/i.test(claim)) named.add('EUR')
  if (/£|\bgbp\b/i.test(claim)) named.add('GBP')
  if (/\bchf\b/i.test(claim)) named.add('CHF')
  if (/\bus\$|\busd\b/i.test(claim)) named.add('USD')
  if (/\ba\$|\baud\b/i.test(claim)) named.add('AUD')
  if (/\bc\$|\bcad\b/i.test(claim)) named.add('CAD')
  return { named, bareDollar: /(?<![a-z])\$/i.test(claim.replace(/\b[usac]\$/gi, '')) }
}

function statesForeignCurrency(claim: string, target: Currency): boolean {
  const { named, bareDollar } = currenciesIn(claim)
  // Any currency other than the market's own makes the claim cross-market, even when the
  // claim also quotes the local one ("€4,999 / US$5,499").
  if ([...named].some((c) => c !== target)) return true
  return bareDollar && target !== 'USD' && target !== 'AUD' && target !== 'CAD'
}

/** True when a price/availability claim rests on another market: the cited URL belongs to a
 *  different country, or the claim quotes a currency the target market does not use. */
export function isCrossMarketClaim(claim: string, url: string, market: Market): boolean {
  if (!isMarketSensitiveClaim(claim)) return false
  const urlCountry = marketOfUrl(url)
  if (urlCountry !== null && urlCountry !== market.country) return true
  return statesForeignCurrency(claim, CURRENCY_OF[market.country])
}
