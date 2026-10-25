/**
 * What a member has used of their limits (ADR 0063), as `GET /api/v1/account/usage` answers it:
 * a live answer, never synced, for Settings and for the subscription cap the reader checks before
 * it subscribes. A limit of `null` is none: so it reads for an admin, whom no member limit bounds
 * (`exempt`). Times are epoch milliseconds.
 */
export type AccountUsage = {
  translations: {
    /** Body translations a day the member's requests may pay for (`member.translationsPerDay`). */
    perDay: number | null
    usedToday: number
    /** Requests that wait for a later day to start. */
    waiting: number
    /** When the next UTC day begins, and the day's count with it. */
    resetsAt: number
  }
  feeds: {
    /** Feeds new to Tela a day (`member.feedsPerDay`); subscribing to one Tela has is free. */
    perDay: number | null
    addedToday: number
    /** Feeds an import named that wait to be added on a later day. */
    pending: number
  }
  subscriptions: { max: number | null; count: number }
  exempt: boolean
}

/**
 * How many days `waiting` feeds take to arrive at `perDay` a day, counting from the next: null when
 * nothing adds them (a day of 0) or nothing waits.
 */
export function daysToArrive(waiting: number, perDay: number | null): number | null {
  if (waiting <= 0 || perDay === 0) return null
  if (perDay === null) return 1
  return Math.ceil(waiting / perDay)
}
