import { Elysia } from 'elysia'
import { createHash, timingSafeEqual } from 'node:crypto'
import { env } from '../env.js'

// Constant-time bearer comparison. Hashing both sides first is what makes `timingSafeEqual`
// applicable to inputs of different lengths without an early length check — which would
// otherwise leak the secret's length one probe at a time on an internet-reachable port.
const expectedDigest = createHash('sha256').update(env.API_SECRET).digest()
function tokenMatches(token: string): boolean {
  return timingSafeEqual(createHash('sha256').update(token).digest(), expectedDigest)
}

// Global Bearer auth guard for every non-public route.
//
// `as: 'scoped'` is required so the lifecycle propagates to sibling plugins
// mounted after this guard (default `local` only reaches descendants of this
// instance, which would leave guarded routes unprotected). See
// dotfiles/rules/elysia.md → "Encapsulation".
//
// Auth runs in `onTransform` (before schema validation) so unauthenticated
// requests can't trigger 422 body-echo responses, and so the validator's CPU
// time is reserved for callers that have already proven the token. Reads the
// Authorization header directly because the `bearer` plugin derives its value
// after `transform`.
export const authGuard = new Elysia({ name: 'auth' }).onTransform(
  { as: 'scoped' },
  ({ request, status }) => {
    const header = request.headers.get('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null
    if (!token || !tokenMatches(token)) {
      throw status(401, 'Unauthorized')
    }
  },
)
