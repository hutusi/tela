/**
 * Sending work to a queue. A queue only speeds work up: every job is also discoverable from state
 * by a sweep, so a message that is lost, duplicated or late costs nothing but time (ADR 0021).
 */
export type QueueMap = Record<string, unknown>

export type JobMessage<T> = { body: T; delaySeconds?: number }

export interface Jobs<Q extends QueueMap> {
  send<K extends keyof Q & string>(
    queue: K,
    body: Q[K],
    options?: { delaySeconds?: number },
  ): Promise<void>
  sendBatch<K extends keyof Q & string>(queue: K, messages: JobMessage<Q[K]>[]): Promise<void>
}

export type SentJob<Q extends QueueMap> = {
  [K in keyof Q & string]: { queue: K; body: Q[K]; delaySeconds: number }
}[keyof Q & string]

/**
 * An in-process queue. Tests inspect `sent` and hand messages to their handlers themselves; the
 * exit path's runner drains it on a timer beside the sweeps.
 */
export function memoryJobs<Q extends QueueMap>(): Jobs<Q> & {
  readonly sent: SentJob<Q>[]
  take<K extends keyof Q & string>(queue: K): Q[K][]
} {
  const sent: SentJob<Q>[] = []
  return {
    sent,
    async send(queue, body, options) {
      sent.push({ queue, body, delaySeconds: options?.delaySeconds ?? 0 } as SentJob<Q>)
    },
    async sendBatch(queue, messages: JobMessage<Q[typeof queue]>[]) {
      for (const m of messages) {
        sent.push({ queue, body: m.body, delaySeconds: m.delaySeconds ?? 0 } as SentJob<Q>)
      }
    },
    take(queue) {
      const out: Q[typeof queue][] = []
      for (let i = sent.length - 1; i >= 0; i--) {
        const job = sent[i]
        if (job?.queue === queue) {
          out.unshift(job.body as Q[typeof queue])
          sent.splice(i, 1)
        }
      }
      return out
    },
  }
}
