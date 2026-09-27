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
