// Geizhals product pages: the offer table as one line per offer, plus the spec grid.
//
// Measured 2026-10-26 on geizhals.de's AirPods Pro 2 (USB-C) page (11 offers, 525 KB): Readability
// keeps the offer rows but drops what a price question needs. Merchant names are logos, so no
// offer says who sells it. The first offer's price and every shipping amount ("PayPal € 8,90")
// are gone, and the remaining prices no longer line up with their rows. The markup carries all
// of it per row: `.gh_price`, `data-merchant-name`, the country flag's alt text, the delivery
// cell and the merchant's own product title with its "Preis vom" timestamp.
//
// A page with no offer rows (search results, categories, a moved layout) returns null and
// falls through to Readability, so a markup change costs this adapter, never the page.
//
// Takes an already-parsed Document; no fetch, env or linkedom import (extract-reddit.ts's
// convention).

interface Element {
  textContent: string | null
  getAttribute(name: string): string | null
  querySelector(selectors: string): Element | null
  querySelectorAll(selectors: string): ArrayLike<Element>
}

export interface GeizhalsDocument {
  querySelector(selectors: string): Element | null
  querySelectorAll(selectors: string): ArrayLike<Element>
}

const MAX_OFFERS = 60
const MAX_SPECS = 40

function text(node: Element | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

// "Bewertung: 3.1 von 5 Sternen 3.1 117 Bewertungen" → "3.1/5 (117 ratings)"
function rating(raw: string): string {
  const m = /([\d.]+) von 5.*?(\d+) Bewertung/.exec(raw)
  return m ? `${m[1]}/5 (${m[2]} ratings)` : ''
}

function offerLine(row: Element, index: number): string | null {
  const price = text(row.querySelector('.offer__price .gh_price'))
  const merchant = row.querySelector('[data-merchant-name]')?.getAttribute('data-merchant-name')?.trim() || text(row.querySelector('.merchant__logo-caption'))
  if (!price && !merchant) return null
  const country = row.querySelector('.offer__merchant img[alt]')?.getAttribute('alt')?.trim()
  const parts = [
    price || 'price not shown',
    country ? `${merchant} (${country})` : merchant,
    rating(text(row.querySelector('.offer__merchant-rating'))),
    text(row.querySelector('.offer__delivery')),
    text(row.querySelector('.offer__details')),
  ].filter(Boolean)
  return `${index}. ${parts.join(' | ')}`
}

// The header block (rating, test score, "ab € …" per variant) also nests the spec grid, its
// expand links and a <style> rule; those are subtracted so the specs appear once, below.
function headerSummary(header: Element | null): string {
  let summary = text(header)
  if (!header) return summary
  for (const nested of Array.from(header.querySelectorAll('.specs-grid, style, script, [class*="specs-grid"]'))) {
    const inner = text(nested)
    if (inner) summary = summary.replace(inner, ' ')
  }
  return summary
    .replace(/(Alle|Beliebteste) Produkteigenschaften anzeigen/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractGeizhalsProduct(document: GeizhalsDocument): string | null {
  const rows = Array.from(document.querySelectorAll('.offerlist .offer')).slice(0, MAX_OFFERS)
  const offers = rows.map((row, i) => offerLine(row, i + 1)).filter((line): line is string => line !== null)
  if (offers.length === 0) return null

  const sections = [`# ${text(document.querySelector('h1'))}`]
  const summary = headerSummary(document.querySelector('.variant__header__specs'))
  if (summary) sections.push(summary)
  sections.push(
    `## Offers (${offers.length}, as Geizhals lists them; prices exclude shipping)\nprice | merchant (country) | merchant rating | availability, shipping and payment | merchant's product title and price timestamp\n${offers.join('\n')}`,
  )

  const specs = Array.from(document.querySelectorAll('.specs-grid__item'))
    .slice(0, MAX_SPECS)
    .map((item) => {
      const key = text(item.querySelector('dt'))
      const value = text(item.querySelector('dd'))
      return key && value ? `- ${key}: ${value}` : null
    })
    .filter((line): line is string => line !== null)
  if (specs.length) sections.push(`## Specs\n${specs.join('\n')}`)

  return sections.join('\n\n')
}
