import { describe, it, expect } from 'bun:test'
import { extractText } from './html-parse.js'

// geizhals.de's AirPods Pro 2 (USB-C) page as served 2026-10-26, trimmed to two offers and two
// specs — same classes and nesting; tracking scripts, payment icons and links dropped.
const offer = (o: { price: string; merchant: string; country: string; rating: string; delivery: string; title: string }) => `
<div class="offer offer--shortly">
  <div class="offer__price offer-cell"><span class="gh_price">${o.price}</span>
    <div class="offer__clickout"><a class="offer_bt" data-merchant-name="${o.merchant}">zum Angebot</a></div></div>
  <div class="offer__merchant offer-cell"><div class="flex"><img src="f.svg" alt="${o.country}">
    <a class="merchant" data-merchant-name="${o.merchant}"><div class="merchant__logo-image"><img alt="${o.merchant}"></div>
    <div class="merchant__logo-caption"> ${o.merchant} </div></a></div></div>
  <div class="offer__merchant-rating offer-cell">${o.rating}</div>
  <div class="offer__delivery offer-cell">${o.delivery}</div>
  <div class="offer__details offer-cell">${o.title}</div>
</div>`
const PAGE = `<html><body><h1>Apple AirPods Pro 2. Generation (USB-C)</h1>
<div class="variant__header__specs">Bewertung: 4.8 von 5 Sternen ab € 184,99 12 Angebote</div>
<div class="specs-grid"><dl class="specs-grid__item"><dt>Bauart</dt><dd>Ohrhörer (In-Ear)</dd></dl>
<dl class="specs-grid__item"><dt>Wireless</dt><dd>Bluetooth 5.3, AAC</dd></dl></div>
<div id="lazy-list--offers" class="offerlist">
<div class="offerlist-header"><div class="offer__price offer-cell">Preis exkl. Versand*</div></div>
${offer({ price: '€ 239,00', merchant: 'Hartlauer', country: 'AT', rating: 'Bewertung: 3.1 von 5 Sternen 3.1 117 Bewertungen', delivery: 'Lagernd - 6 bis 8 Werktage Lieferzeit Kreditkarte, PayPal € 8,90.', title: 'Apple AirPods Pro 2. Generation mit MagSafe USB-C Preis vom: 26.10.2026, 13:37:56' })}
${offer({ price: '€ 245,00', merchant: 'PC-KING', country: 'DE', rating: 'Bewertung: 3.1 von 5 Sternen 3.1 296 Bewertungen', delivery: 'Lieferzeit 1-2 Tage Vorkasse, PayPal ab € 8,-.', title: 'Apple AirPods Pro - 2. Generation Preis vom: 26.10.2026, 13:28:48' })}
</div></body></html>`

describe('geizhals reader', () => {
  it('keeps merchant, price and shipping together on one line per offer', async () => {
    const { via, text } = await extractText('https://geizhals.de/apple-airpods-pro-2-generation-usb-c-mtjv3zm-a-a3026713.html', PAGE)
    expect(via).toBe('site-adapter')
    expect(text).toContain('# Apple AirPods Pro 2. Generation (USB-C)')
    expect(text).toContain('## Offers (2, as Geizhals lists them; prices exclude shipping)')
    expect(text).toContain('1. € 239,00 | Hartlauer (AT) | 3.1/5 (117 ratings) | Lagernd - 6 bis 8 Werktage Lieferzeit Kreditkarte, PayPal € 8,90.')
    expect(text).toContain('2. € 245,00 | PC-KING (DE)')
    expect(text).toContain('Preis vom: 26.10.2026, 13:28:48')
    expect(text).toContain('- Wireless: Bluetooth 5.3, AAC')
  })

  it('falls through to Readability when the page has no offer rows', async () => {
    const search = '<html><body><h1>Suche: ZTE MC889</h1><article><p>' + 'Ergebnisliste ohne Angebote. '.repeat(20) + '</p></article></body></html>'
    const { via } = await extractText('https://geizhals.eu/?fs=ZTE+MC889', search)
    expect(via).toBe('readability')
  })
})
