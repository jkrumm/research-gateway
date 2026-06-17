import { Elysia } from 'elysia'
import { z } from 'zod'
import { openapi } from '@elysiajs/openapi'
import { env } from './env.js'
import { authGuard } from './lib/auth-guard.js'
import { healthRoute } from './routes/health.js'
import { researchRoutes } from './routes/research.js'
import { mcpRoutes } from './routes/mcp.js'

export const app = new Elysia()
  .use(
    openapi({
      mapJsonSchema: { zod: z.toJSONSchema },
      documentation: {
        info: {
          title: 'research-gateway',
          version: '0.1.0',
          description:
            'Agentic research gateway. Accepts a query, runs a multi-step tool-calling loop (Tavily search + page fetch + library docs), and returns a cited markdown report. All routes except `GET /` and `GET /health` require `Authorization: Bearer <API_SECRET>`.',
        },
        components: {
          securitySchemes: {
            BearerAuth: { type: 'http', scheme: 'bearer' },
          },
        },
        tags: [
          {
            name: 'Research',
            description: 'Submit and poll agentic research jobs.',
          },
          {
            name: 'System',
            description: 'Discovery and health endpoints.',
          },
        ],
      },
    }),
  )
  .onError(({ error }) => {
    console.error('[error]', error)
  })
  .get(
    '/',
    () => ({
      name: 'research-gateway',
      version: '0.1.0',
      docs: {
        scalar: '/openapi',
        json: '/openapi/json',
      },
      auth: {
        scheme: 'Bearer',
        header: 'Authorization: Bearer <API_SECRET>',
        public: ['GET /', 'GET /health'],
      },
      endpoints: {
        submit: 'POST /research',
        poll: 'GET /research/:jobId',
      },
      mcp: {
        endpoint: '/mcp',
        transport: 'streamable-http',
        tool: 'research',
      },
    }),
    {
      response: z.object({
        name: z.string(),
        version: z.string(),
        docs: z.object({
          scalar: z.string().describe('Interactive OpenAPI UI'),
          json: z.string().describe('Raw OpenAPI JSON spec'),
        }),
        auth: z.object({
          scheme: z.string(),
          header: z.string(),
          public: z.array(z.string()),
        }),
        endpoints: z.object({
          submit: z.string(),
          poll: z.string(),
        }),
        mcp: z.object({
          endpoint: z.string(),
          transport: z.string(),
          tool: z.string(),
        }),
      }),
      detail: {
        tags: ['System'],
        summary: 'API discovery — start here',
        description:
          'Public root endpoint. Returns the service name, version, where to find the OpenAPI spec, auth scheme, and the main research endpoints.',
      },
    },
  )
  .use(healthRoute)
  .use(authGuard)
  .use(mcpRoutes)
  .use(researchRoutes)
  .listen({ port: env.PORT, idleTimeout: 255 })

export type App = typeof app

// eslint-disable-next-line no-console
console.log(`research-gateway running on port ${env.PORT}`)
