import { Elysia } from 'elysia'
import { z } from 'zod'
import { createLedger } from '../agent/ledger.js'
import { runFetchChain } from '../agent/fetch-chain.js'

// Diagnostics: run ONE url through the real fetch chain and report which step terminated it.
//
// This exists because the fetch chain was, until now, only observable from inside a research
// job — and the job-level benchmark cannot resolve fetch effects. Over 15 runs and 487
// fetchPage outcomes, `pagesFailed` moved 10.8% → 11.3% at cv 1.00: the noise floor is wider
// than any plausible improvement to a single step. Answering "is the renderer earning its
// container" that way costs ~90 minutes and ~$1.35 per configuration and still cannot decide
// it.
//
// Driving the chain directly costs one HTTP round trip per URL, is deterministic, and answers
// exactly the question the job benchmark cannot. `scripts/fetch-bench.ts` is the client.
//
// It hits the DEPLOYED chain on purpose — same container, same sidecar, same egress IP — so
// what it measures is what research jobs actually get, not what a laptop can reach.
export const probeRoutes = new Elysia().post(
  '/probe/fetch',
  async ({ body }) => {
    const startedAt = performance.now()
    // A throwaway ledger: the chain records into it, nothing reads it back. Grounding is a
    // property of a research job, and this is not one.
    const ledger = createLedger()
    let tavilyCredits = 0

    const result = await runFetchChain(body.url, {
      ledger,
      jobId: 'probe',
      onTavilyCredits: (credits) => {
        tavilyCredits += credits
      },
    })

    return {
      url: result.url,
      fetchUrl: result.fetchUrl,
      via: result.via,
      chars: result.text?.length ?? 0,
      // The first stretch of what was actually recovered. Character count alone cannot tell a
      // real page from a success-shaped failure — a Cloudflare interstitial, a "browser not
      // supported" banner and a cookie wall all clear a length threshold. Reading the opening
      // line is how a human tells those apart, so the bench prints it.
      preview: result.text ? result.text.slice(0, 300) : null,
      error: result.error,
      attempts: result.attempts,
      tavilyCredits,
      totalMs: Math.round(performance.now() - startedAt),
    }
  },
  {
    body: z.object({
      url: z.string().describe('The URL to run through the fetch chain'),
    }),
    response: z.object({
      url: z.string(),
      fetchUrl: z.string().describe('The address actually dialled — differs when a site adapter rewrites it'),
      via: z
        .enum(['raw', 'site-adapter', 'readability', 'lightpanda', 'yt-dlp', 'tavily-extract'])
        .nullable()
        .describe('The step that terminated the chain, or null if every step failed'),
      chars: z.number(),
      preview: z.string().nullable(),
      error: z.string().nullable(),
      attempts: z.array(
        z.object({
          step: z.enum(['raw', 'site-adapter', 'readability', 'lightpanda', 'yt-dlp', 'tavily-extract']),
          ok: z.boolean(),
          chars: z.number().optional(),
          error: z.string().optional(),
          ms: z.number(),
        }),
      ),
      tavilyCredits: z.number().describe('Credits Tavily billed for this probe — non-zero only if the chain reached Extract'),
      totalMs: z.number(),
    }),
    detail: {
      tags: ['System'],
      summary: 'Fetch-chain diagnostic probe',
      description:
        'Runs a single URL through the real page-fetch chain (site adapter → Readability → Lightpanda → Tavily Extract, or yt-dlp → Tavily Extract for a YouTube URL) and reports which step terminated it, how many characters each step recovered, and how long each took. No LLM is involved. Reaching Tavily Extract costs credits, which are reported. Used by `scripts/fetch-bench.ts`.',
    },
  },
)
