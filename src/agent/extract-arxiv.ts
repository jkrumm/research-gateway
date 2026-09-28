// arXiv's LaTeXML HTML build reader — split out of site-adapters.ts, same convention as
// extract-reddit.ts / extract-wrchina.ts: a per-site extractor lives in its own module, and
// site-adapters.ts only wires it up (arxivAdapter's `plan`/`fallbackUrl`, which is routing, not
// extraction, and stays there).
//
// LaTeXML's HTML build represents an equation as `<math alttext="...">` — MEASURED to carry
// the exact LaTeX source (`Y\mid X\sim\mathcal{F}_{\bm{\theta}}`), strictly better than any
// glyph reconstruction `pdftotext` could do on the same formula in the PDF — and a table as
// `<table class="ltx_tabular">`. This walks the article body substituting `$<alttext>$` for
// each formula and rendering table rows as ` | `-joined cells, one row per line, so a worker
// reads the paper's actual equations and tables rather than losing them to prose extraction.
// Returns null when the page is not a LaTeXML document (a 404, or any other page this module
// was never meant to touch), so Readability takes over exactly as if there were no adapter.
//
// A richer structural view than extract-reddit.ts's MinimalDocument — reconstructing reading
// order needs node identity (text vs element), attributes and child order, which a flat
// querySelectorAll cannot give it. Still dependency-free: linkedom's real DOM implements every
// member used here, so this stays a type-only contract, not an import; the mismatch with
// `SiteAdapter.extract`'s declared (narrower) parameter type is bridged with one cast at
// site-adapters.ts's `arxivAdapter` definition, the same way parse-worker.ts casts its call
// site.
export interface LatexmlNode {
  nodeType: number
  nodeValue: string | null
  tagName?: string
  childNodes: ArrayLike<LatexmlNode>
  getAttribute?(name: string): string | null
  querySelectorAll?(selectors: string): ArrayLike<LatexmlNode>
}
export interface LatexmlDocument {
  querySelector(selectors: string): LatexmlNode | null
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1
// Tags whose content gets a line break after it, so paragraphs/headings/list items don't run
// together into one unbroken line once every element boundary is otherwise invisible.
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'article'])

/** `<math alttext="...">` → `$<alttext>$` — the one rule shared by `walkLatexml`'s math branch
 * and `textWithMath`'s, so it exists in exactly one place. Returns null for a non-math node, or
 * a math node with no `alttext`, so each caller decides its own fallback. */
function mathAsText(node: LatexmlNode): string | null {
  if (node.tagName?.toLowerCase() !== 'math') return null
  const alttext = node.getAttribute?.('alttext')
  return alttext ? `$${alttext}$` : null
}

/** Plain text of a subtree, substituting `$<alttext>$` for any formula inside it — used for table cells, which may themselves contain inline math. */
function textWithMath(node: LatexmlNode): string {
  if (node.nodeType === TEXT_NODE) return node.nodeValue ?? ''
  if (node.nodeType !== ELEMENT_NODE) return ''
  const math = mathAsText(node)
  if (math) return math
  return Array.from(node.childNodes)
    .map((c) => textWithMath(c))
    .join('')
}

function tableRowsAsText(table: LatexmlNode): string {
  const rows = Array.from(table.querySelectorAll?.('tr') ?? [])
  const lines: string[] = []
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll?.('td, th') ?? [])
    const cellText = cells.map((c) => textWithMath(c).trim()).filter(Boolean)
    if (cellText.length > 0) lines.push(cellText.join(' | '))
  }
  return lines.join('\n')
}

/** Renders `node` as one leaf string when it's a math formula or a LaTeXML table — the two
 * element kinds `walkLatexml` renders wholesale rather than recursing into their children.
 * Returns null for anything else, so the caller recurses instead. Split out of `walkLatexml`
 * to keep its own branching to the tree-walk shape alone. */
function renderLatexmlLeaf(node: LatexmlNode, tag: string | undefined): string | null {
  if (tag === 'math') return mathAsText(node) ?? textWithMath(node)
  const classAttr = node.getAttribute?.('class') ?? ''
  if (tag === 'table' && /\bltx_tabular\b/.test(classAttr)) return `\n${tableRowsAsText(node)}\n`
  return null
}

function walkLatexml(node: LatexmlNode, out: string[]): void {
  if (node.nodeType === TEXT_NODE) {
    if (node.nodeValue) out.push(node.nodeValue)
    return
  }
  if (node.nodeType !== ELEMENT_NODE) return
  const tag = node.tagName?.toLowerCase()
  const rendered = renderLatexmlLeaf(node, tag)
  if (rendered !== null) {
    out.push(rendered)
    return
  }
  for (const child of Array.from(node.childNodes)) walkLatexml(child, out)
  if (tag && BLOCK_TAGS.has(tag)) out.push('\n')
}

export function extractArxivHtml(document: LatexmlDocument): string | null {
  const article = document.querySelector('article.ltx_document') ?? document.querySelector('.ltx_document')
  if (!article) return null // not a LaTeXML page (a 404, or something else entirely)
  const out: string[] = []
  walkLatexml(article, out)
  const text = out.join('')
  return text.trim().length > 0 ? text : null
}
