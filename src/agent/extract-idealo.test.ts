import { describe, it, expect } from 'bun:test'
import { extractText } from './html-parse.js'

// idealo.de's AirPods Pro 2 (USB-C) offers page as served 2026-10-26 through the impit rung,
// trimmed to two offers — same classes and nesting; tracking attributes and payment icons dropped.
const offer = (o: { shop: string; price: string; delivery: string; rating: string; title: string }) => `
<li class="productOffers-listItem row" data-mtrx-click='{"shop_name":"${o.shop.split(' - ')[0]}"}'>
  <div class="productOffers-listItemTitleWrapper"><a class="productOffers-listItemTitle"><span class="productOffers-listItemTitleInner">${o.title}</span></a></div>
  <div class="productOffers-listItemOffer"><div class="price-and-badge-wrapper"><a class="productOffers-listItemOfferPrice"> ${o.price}</a>
    <div class="productOffers-listItemOfferShippingDetails"> ${o.price} inkl. Versand</div></div></div>
  <div class="productOffers-listItemOfferDeliveryBlock">${o.delivery}</div>
  <div class="productOffers-listItemOfferShopV2"><img class="productOffers-listItemOfferShopV2LogoImage" alt="${o.shop}">
    <div class="productOffers-listItemOfferShopV2RatingsContainer">${o.rating}</div></div>
</li>`
const PAGE = `<html><body><h1 id="oopStage-title">Apple AirPods Pro 2 mit USB‑C MagSafe Case</h1>
<ul class="productOffers-list">
${offer({ shop: 'bosaverna.de - Shop aus Ludwigsfelde', price: '179,49 €', delivery: 'Lieferung: bis Fr. 30.10. DPD DHL GLS', rating: '4,4 34', title: 'Apple AirPods Pro 2 mit USB-C MagSafe Case MTJV3RU/A' })}
${offer({ shop: 'mediamarkt.de (Marktplatzhändler) - Shop aus Ingolstadt', price: '199,95 €', delivery: 'Lieferung: bis Sa. 31.10.', rating: '1,3 250', title: 'APPLE MTJV3ZM/A AIRPODS PRO 2ND GEN.' })}
</ul>
<section class="reviews"><p>${'Die AirPods sind sehr gut verarbeitet. '.repeat(40)}</p></section>
</body></html>`

describe('idealo reader', () => {
  it('reads the offer rows instead of the reviews below them', async () => {
    const { via, text } = await extractText('https://www.idealo.de/preisvergleich/OffersOfProduct/203255713_-airpods-pro-2.html', PAGE)
    expect(via).toBe('site-adapter')
    expect(text).toContain('## Offers (2, as idealo lists them)')
    expect(text).toContain('1. 179,49 € | bosaverna.de - Shop aus Ludwigsfelde | 179,49 € inkl. Versand | Lieferung: bis Fr. 30.10. DPD DHL GLS | shop rating 4,4/5 (34 ratings)')
    expect(text).toContain('2. 199,95 € | mediamarkt.de (Marktplatzhändler) - Shop aus Ingolstadt')
    expect(text).not.toContain('sehr gut verarbeitet')
  })

  it('falls through to Readability on a page without offer rows', async () => {
    const list = `<html><body><article><h1>Gravelbikes</h1><p>${'Stahlrahmen-Gravelbikes im Vergleich. '.repeat(20)}</p></article></body></html>`
    const { via } = await extractText('https://www.idealo.de/preisvergleich/Liste/119682881/gravelbike.html', list)
    expect(via).toBe('readability')
  })
})
