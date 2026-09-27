import { describe, it, expect } from 'bun:test'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { stripConsentOverlays } from './consent.js'

const BANNER = `<div id="onetrust-consent-sdk"><div id="onetrust-banner-sdk"><p>${'Wenn Sie auf „Alle Cookies akzeptieren" klicken, stimmen Sie der Speicherung von Cookies auf Ihrem Gerät zu, um die Websitenavigation zu verbessern. '.repeat(4)}</p><button>Alle Cookies akzeptieren</button></div></div>`
const ARTICLE = `<main><h1>Gebrauchte Kameras</h1><p>${'Kaufe und verkaufe gebrauchte Kameraausrüstung, geprüft und mit Garantie. '.repeat(3)}</p></main>`

function read(html: string, strip: boolean): string {
  const { document } = parseHTML(`<html><body>${html}</body></html>`)
  if (strip) stripConsentOverlays(document)
  return new Readability(document as never).parse()?.textContent?.trim() ?? ''
}

describe('stripConsentOverlays', () => {
  it('removes a OneTrust container and returns the count', () => {
    const { document } = parseHTML(`<html><body>${BANNER}${ARTICLE}</body></html>`)
    expect(stripConsentOverlays(document)).toBe(1)
    expect(document.querySelector('#onetrust-banner-sdk')).toBeNull()
  })

  it('lets Readability read the page instead of the consent dialog', () => {
    const text = read(BANNER + ARTICLE, true)
    expect(text).toContain('Kameraausrüstung')
    expect(text).not.toContain('Cookies akzeptieren')
  })

  it('keeps a page ABOUT cookies — matching is by consent-manager container, never by the word', () => {
    const policy = `<article><h1>Cookie policy</h1><p>${'We use cookies to remember your settings and measure traffic. '.repeat(5)}</p></article>`
    const { document } = parseHTML(`<html><body>${policy}</body></html>`)
    expect(stripConsentOverlays(document)).toBe(0)
    expect(read(policy, true)).toContain('We use cookies')
  })
})
