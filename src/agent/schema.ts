import { z } from 'zod'

export const Depth = z.enum(['quick', 'standard', 'deep'])
export type Depth = z.infer<typeof Depth>

export const ResearchInput = z.object({
  query: z.string().min(3),
  depth: Depth.optional(),
})
export type ResearchInput = z.infer<typeof ResearchInput>

export const ResearchReport = z.object({
  report: z.string().describe('Narrative, cited answer in markdown'),
  citations: z
    .array(z.object({ claim: z.string(), url: z.string() }))
    .describe('Each key claim tied to a source URL'),
  sources: z.array(z.string()).describe('Deduplicated list of all source URLs consulted'),
})
export type ResearchReport = z.infer<typeof ResearchReport>
