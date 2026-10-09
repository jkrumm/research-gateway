import type { WorkerDigest } from './schema.js'

// Env-free so it is unit-tested. The consistency pass costs a p50 of ~29k reasoning tokens to
// land ~230 chars of edits, and 7 of 8 passes since the Wave 8 deploy changed nothing. The
// only contradiction the pass can fix is one the digests already carry: the same subject
// reported with a different number, date or version by two independent workers. This is the
// cheap deterministic pre-check for exactly that — no match means no pass.
//
// Heuristic: split every digest into statements (each finding claim, each summary sentence),
// pull the numeric facts out of each (typed by KIND: iso date, currency, percent, version,
// or a plain number keyed by its unit word; bare years and unit-less numbers are ignored), and treat two statements from DIFFERENT
// digests as the same subject when they share >= MIN_SHARED salient words (a shared source
// host counts as one). A divergence is a kind both statements carry where the two value sets
// are disjoint. Biased towards running — a false positive costs one pass, a false negative
// loses a rare correction — but kind-typing keeps unrelated figures ("5 users" vs "200 ms",
// a 2023 release vs a 2024 update on different subjects) from ever being compared.

const MIN_SHARED = 3
const MIN_PLAIN_NUMBER = 10
const MAX_SIGNALS = 20

export interface DivergenceSignal {
  kind: string
  values: [string, string]
  shared: string[]
}

export interface DigestDivergence {
  count: number
  signals: DivergenceSignal[]
}

const STOPWORDS = new Set(
  (
    'about above after again also and any are because been before being between both but can could did does doing down during each ' +
    'few for from further had has have having her here him his how into its just like may more most much must not now off once only ' +
    'other our out over own per same she should some such than that the their them then there these they this those through too under ' +
    'until very was were what when where which while who whom why will with would you your according based including however ' +
    'report page source sources found shows show shown states stated listed lists reports reported'
  ).split(' '),
)

const FUNCTION_WORDS = new Set(['a', 'an', 'as', 'at', 'by', 'in', 'is', 'of', 'on', 'or', 'to', 'up', 'vs', 'it', 'if', 'be'])

// Alternation order is priority order: a date is not a year plus noise, "$12.99" is not a
// dotted version. Each group yields one typed value.
const NUMERIC =
  /(?<date>\b\d{4}-\d{2}-\d{2}\b)|(?<currency>[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|dollars?|euros?)\b)|(?<percent>\b\d+(?:\.\d+)?\s?%)|(?<version>\bv\d+(?:\.\d+)*\b|\b\d+\.\d+\.\d+(?:\.\d+)*\b|(?<=\bversion\s)\d+\.\d+\b)|(?<year>\b(?:19|20)\d{2}\b)|(?<plain>\b\d[\d,]*(?:\.\d+)?\b)/gi

const URL_OR_LINK = /https?:\/\/\S+|\]\([^)]*\)/gi

interface Statement {
  digest: number
  host: string | null
  tokens: Set<string>
  facts: Map<string, Set<string>>
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

function normalizeAmount(raw: string): string {
  return String(Number(raw.replace(/[^\d.]/g, '')))
}

const CURRENCY_CODES: Record<string, string> = { '$': 'usd', '€': 'eur', '£': 'gbp', dollar: 'usd', dollars: 'usd', euro: 'eur', euros: 'eur' }

// "$100" and "100 USD" are the same value; "$100" and "€100" are not — the denomination is part of it.
function currencyValue(raw: string): string {
  const code = /[$€£]|[a-z]+$/.exec(raw.trim())?.[0] ?? ''
  return `${CURRENCY_CODES[code] ?? code} ${normalizeAmount(raw)}`
}

function addFact(facts: Map<string, Set<string>>, kind: string, value: string): void {
  const values = facts.get(kind)
  if (values) values.add(value)
  else facts.set(kind, new Set([value]))
}

function toStatement(digest: number, text: string, host: string | null): Statement | null {
  const clean = text.replace(URL_OR_LINK, ' ').toLowerCase()
  const facts = new Map<string, Set<string>>()
  for (const m of clean.matchAll(NUMERIC)) {
    const g = m.groups ?? {}
    const raw = m[0]
    if (g['date']) addFact(facts, 'date', raw)
    else if (g['currency']) addFact(facts, 'currency', currencyValue(raw))
    else if (g['percent']) addFact(facts, 'percent', normalizeAmount(raw))
    else if (g['version']) addFact(facts, 'version', raw.replace(/^v/, ''))
    // A bare year is not a fact about a subject: release and retrieval years differ in every report.
    else if (g['year']) continue
    else if (g['plain']) {
      const value = Number(raw.replace(/,/g, ''))
      if (value < MIN_PLAIN_NUMBER) continue
      // "200 ms" and "5 users" are different measures — the unit word is part of the kind.
      const unit = /^\s*([a-z]+)/.exec(clean.slice((m.index ?? 0) + raw.length))?.[1] ?? ''
      // Without a unit word the number is an id, a rank or a model number, not a measure.
      if (unit === '' || STOPWORDS.has(unit) || FUNCTION_WORDS.has(unit)) continue
      addFact(facts, `number:${unit}`, String(value))
    }
  }
  if (facts.size === 0) return null
  const tokens = new Set(
    (clean.replace(NUMERIC, ' ').match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w)),
  )
  return { digest, host, tokens, facts }
}

function statementsOf(digests: readonly WorkerDigest[]): Statement[] {
  const out: Statement[] = []
  digests.forEach((d, i) => {
    const push = (text: string, host: string | null) => {
      const s = toStatement(i, text, host)
      if (s) out.push(s)
    }
    for (const f of d.findings) push(f.claim, hostOf(f.url))
    for (const sentence of d.summary.split(/(?<=[.!?])\s+|\n+/)) push(sentence, null)
  })
  return out
}

function disjoint(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const v of a) if (b.has(v)) return false
  return true
}

export function detectDigestDivergence(digests: readonly WorkerDigest[]): DigestDivergence {
  const statements = statementsOf(digests)
  const seen = new Set<string>()
  const signals: DivergenceSignal[] = []
  let count = 0

  for (let i = 0; i < statements.length; i++) {
    const a = statements[i]!
    for (let j = i + 1; j < statements.length; j++) {
      const b = statements[j]!
      if (a.digest === b.digest) continue
      const shared = [...a.tokens].filter((t) => b.tokens.has(t))
      const sameHost = a.host !== null && a.host === b.host
      if (shared.length + (sameHost ? 1 : 0) < MIN_SHARED) continue
      for (const [kind, av] of a.facts) {
        const bv = b.facts.get(kind)
        if (!bv || !disjoint(av, bv)) continue
        const x = [...av].sort().join('/')
        const y = [...bv].sort().join('/')
        const key = x < y ? `${kind}|${x}|${y}` : `${kind}|${y}|${x}`
        if (seen.has(key)) continue
        seen.add(key)
        count++
        if (signals.length < MAX_SIGNALS) signals.push({ kind, values: x < y ? [x, y] : [y, x], shared: shared.slice(0, 4) })
      }
    }
  }
  return { count, signals }
}

// Bounded one-line-per-signal view for the skip log and span attributes — enough for the next
// audit to see WHAT diverged without a HyperDX row turning into a document.
export function divergenceSummary(divergence: DigestDivergence, limit = 3): string[] {
  return divergence.signals
    .slice(0, limit)
    .map((s) => `${s.kind} ${s.values[0]} vs ${s.values[1]} [${s.shared.join(' ')}]`)
}
