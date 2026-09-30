/** Epoch milliseconds, injectable so leases and backoff can be tested without waiting. */
export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }
