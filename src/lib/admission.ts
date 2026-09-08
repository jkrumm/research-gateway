// Admission control — pure decision function for whether the service should accept a NEW
// research job right now, given three independent shedding signals (draining, memory
// pressure, queue depth). Dependency-free by design (no `env.js`) so it is unit-testable
// without booting the env/LLM import chain — same convention as `ledger.ts` / `extract.ts` /
// `response-kind.ts`. `job-store.ts` owns the mutable state this reads and calls `admit()`.

export type AdmissionState = {
  draining: boolean
  memoryPressure: boolean
  running: number
  queued: number
  maxQueue: number
}

export type AdmissionRefusal = {
  reason: 'draining' | 'memory_pressure' | 'queue_full'
  httpStatus: 503 | 429
  retryAfterSeconds: number
  message: string
}

// The dispatch half of the same policy. `admit()` decides whether a job may be CREATED;
// this decides whether one already sitting in the concurrency queue may START. They have to
// agree, or shedding is theatre: refusing new submissions while the backlog keeps feeding the
// slot a finishing job just freed replaces exactly the memory that job released, and the
// container walks into the same OOM kill with a 503 on the door.
//
// `draining` is not a parameter here for the same reason it does not need to be: the shutdown
// path rejects every queued waiter outright, so there is nothing left to dispatch.
export function canDispatch(state: {
  memoryPressure: boolean
  running: number
  queued: number
  maxConcurrency: number
}): boolean {
  if (state.memoryPressure) return false
  return state.running < state.maxConcurrency && state.queued > 0
}

// Precedence, first match wins: a draining process is going away regardless of memory, and
// memory pressure is a harder ceiling than the queue size — both must be checked before the
// queue-depth admission math even runs.
export function admit(state: AdmissionState): AdmissionRefusal | null {
  if (state.draining) {
    return {
      reason: 'draining',
      httpStatus: 503,
      retryAfterSeconds: 30,
      message: 'The service is restarting and is not accepting new research jobs; retry in a few seconds.',
    }
  }
  if (state.memoryPressure) {
    return {
      reason: 'memory_pressure',
      httpStatus: 503,
      retryAfterSeconds: 60,
      message:
        'The service is under memory pressure and is shedding new work to protect the jobs already running; retry shortly.',
    }
  }
  if (state.running + state.queued >= state.maxQueue) {
    return {
      reason: 'queue_full',
      httpStatus: 429,
      retryAfterSeconds: 30,
      message: 'Research queue is full, retry shortly',
    }
  }
  return null
}
