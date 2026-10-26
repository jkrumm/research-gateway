// Idealo offer pages (`/preisvergleich/OffersOfProduct/…`): one line per offer.
//
// Measured 2026-10-26 on idealo.de's AirPods Pro 2 (USB-C) offers page (13 offers, 811 KB through
// the impit rung): Readability kept 12k chars of user reviews and not one offer, and the JSON-LD
// carries only the price range (`lowPrice`/`highPrice`/`offerCount`). Each
// `li.productOffers-listItem` holds the shop (logo alt, "<shop> - Shop aus <city>"), the
// merchant's title, the price, the total including shipping, the delivery window and the shop
// rating.
//
// A page with no offer rows (category lists, search results, a moved layout) returns null and
// falls through to Readability. Takes an already-parsed Document (extract-reddit.ts's
// convention).

interface Element {
  textContent: string | null
  getAttribute(name: string): string | null
  querySelector(selectors: string): Element | null
  querySelectorAll(selectors: string): ArrayLike<Element>
}

export interface IdealoDocument {
  querySelector(selectors: string): Element | null
  querySelectorAll(selectors: string): ArrayLike<Element>
}

const MAX_OFFERS = 60

function text(node: Element | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function shopOf(row: Element): string {
  const alt = row.querySelector('.productOffers-listItemOfferShopV2LogoImage')?.getAttribute('alt')?.trim()
  if (alt) return alt
  try {
    const name = (JSON.parse(row.getAttribute('data-mtrx-click') ?? '{}') as { shop_name?: unknown }).shop_name
    return typeof name === 'string' ? name : ''
  } catch {
    return ''
  }
}

// "4,4 34" → "4,4/5 (34 ratings)"; a shop without ratings renders no numbers at all.
function rating(raw: string): string {
  const m = /^(\d+,\d)\s+(\d+)/.exec(raw)
  return m ? `shop rating ${m[1]}/5 (${m[2]} ratings)` : ''
}

function offerLine(row: Element, index: number): string | null {
  const price = text(row.querySelector('.productOffers-listItemOfferPrice'))
  const shop = shopOf(row)
  if (!price && !shop) return null
  const parts = [
    price || 'price not shown',
    shop,
    text(row.querySelector('.productOffers-listItemOfferShippingDetails')),
    text(row.querySelector('.productOffers-listItemOfferDeliveryBlock')),
    rating(text(row.querySelector('.productOffers-listItemOfferShopV2RatingsContainer'))),
    text(row.querySelector('.productOffers-listItemTitleInner')),
  ].filter(Boolean)
  return `${index}. ${parts.join(' | ')}`
}

export function extractIdealoOffers(document: IdealoDocument): string | null {
  const rows = Array.from(document.querySelectorAll('li.productOffers-listItem')).slice(0, MAX_OFFERS)
  const offers = rows.map((row, i) => offerLine(row, i + 1)).filter((line): line is string => line !== null)
  if (offers.length === 0) return null
  return [
    `# ${text(document.querySelector('h1'))}`,
    `## Offers (${offers.length}, as idealo lists them)\nprice | shop | total incl. shipping | delivery | shop rating | merchant's product title\n${offers.join('\n')}`,
  ].join('\n\n')
}
