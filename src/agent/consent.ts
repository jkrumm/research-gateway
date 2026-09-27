// Cookie-consent overlays are removed before Readability runs. A consent manager injects its
// dialog into the same DOM as the article, and on a page whose own content is short or
// script-rendered, Readability can score the dialog as the main article. MEASURED 2026-09-27:
// mpb.com/de-de read through the solver browser returned 238 chars of OneTrust's
// "Alle Cookies akzeptieren…" text — above the 200-char floor, so it was recorded as a
// successful read. The day before, the same page gave 2,440 chars of real content.
//
// Matched by the consent managers' own container ids/classes, never by the word "cookie": a
// page ABOUT cookies (a privacy policy, a GDPR explainer) must keep its text.
const CONSENT_SELECTORS = [
  '#onetrust-consent-sdk',
  '#onetrust-banner-sdk',
  '#onetrust-pc-sdk',
  '#CybotCookiebotDialog',
  '#CybotCookiebotDialogBodyUnderlay',
  '#usercentrics-root',
  '#usercentrics-cmp-ui',
  '#didomi-host',
  '#qc-cmp2-container',
  '.qc-cmp2-container',
  '#truste-consent-track',
  '.truste_box_overlay',
  '[id^="sp_message_container"]',
  '.osano-cm-window',
  '#cmplz-cookiebanner-container',
  '#BorlabsCookieBox',
  '.cky-consent-container',
  '.cky-modal',
].join(',')

interface QueryableDocument {
  querySelectorAll(selectors: string): ArrayLike<{ remove(): void; readonly isConnected: boolean }>
}

/** Removes known consent-manager containers in place; returns how many top-level ones were
 * removed (a matched node nested inside an already-removed one is not counted twice). */
export function stripConsentOverlays(document: QueryableDocument): number {
  let removed = 0
  for (const node of Array.from(document.querySelectorAll(CONSENT_SELECTORS))) {
    if (!node.isConnected) continue
    node.remove()
    removed++
  }
  return removed
}
