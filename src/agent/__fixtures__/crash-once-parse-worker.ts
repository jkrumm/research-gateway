// Fixture for parse-pool.test.ts's crash-recovery case: throws (crashing the worker thread)
// on any request whose `url` starts with `crash:`, and otherwise answers with a trivial,
// deterministic reply. It does not replicate the production parse logic — that parity is
// already covered against the real `parse-worker.ts` — this file exists only to prove the
// POOL replaces a dead worker and keeps serving the next request.
interface ParseRequest {
  id: number
  html: string
  url: string
}

addEventListener('message', (event: MessageEvent<ParseRequest>) => {
  const { id, url } = event.data
  if (url.startsWith('crash:')) {
    throw new Error('simulated worker crash')
  }
  postMessage({ id, via: 'readability', text: 'ok' })
})
