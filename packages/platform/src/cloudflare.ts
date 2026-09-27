/**
 * Cloudflare bindings behind Tela's platform interfaces. This is the only module in the monorepo
 * that touches a binding (ADR 0020); everything else takes a Db, Blobs or Jobs.
 */
import type { D1Database, Queue, R2Bucket } from '@cloudflare/workers-types'
import { drizzle } from 'drizzle-orm/d1'
import type { Blobs } from './blobs'
import type { Db } from './db'
import type { Jobs, QueueMap } from './jobs'

/** Drizzle over a D1 binding. */
export function d1Db<TSchema extends Record<string, unknown>>(
  binding: D1Database,
  schema: TSchema,
): Db<TSchema> {
  return drizzle(binding, { schema, casing: 'snake_case' }) as unknown as Db<TSchema>
}

/** R2 through its Worker binding. */
export function r2Blobs(bucket: R2Bucket): Blobs {
  return {
    async get(key) {
      const obj = await bucket.get(key)
      if (!obj) return null
      return {
        key,
        size: obj.size,
        contentType: obj.httpMetadata?.contentType ?? null,
        text: () => obj.text(),
        arrayBuffer: () => obj.arrayBuffer(),
      }
    },
    async head(key) {
      const obj = await bucket.head(key)
      return obj
        ? { key, size: obj.size, contentType: obj.httpMetadata?.contentType ?? null }
        : null
    },
    async put(key, body, options) {
      await bucket.put(key, body, {
        httpMetadata: {
          ...(options?.contentType ? { contentType: options.contentType } : {}),
          ...(options?.cacheControl ? { cacheControl: options.cacheControl } : {}),
        },
      })
    },
    async delete(key) {
      await bucket.delete(key)
    },
    async list({ prefix, cursor, limit = 1000 }) {
      const page = await bucket.list({ prefix, limit, ...(cursor ? { cursor } : {}) })
      return { keys: page.objects.map((o) => o.key), cursor: page.truncated ? page.cursor : null }
    },
  }
}

/** Queues bindings by name. A queue without a binding is a configuration error, not a no-op. */
export function queueJobs<Q extends QueueMap>(bindings: { [K in keyof Q]: Queue<Q[K]> }): Jobs<Q> {
  const queue = <K extends keyof Q>(name: K): Queue<Q[K]> => {
    const binding = bindings[name]
    if (!binding) throw new Error(`No queue binding for ${String(name)}`)
    return binding
  }
  return {
    async send(name, body, options) {
      await queue(name).send(
        body,
        options?.delaySeconds ? { delaySeconds: options.delaySeconds } : {},
      )
    },
    async sendBatch(name, messages) {
      // Queues accepts at most 100 messages per sendBatch call.
      for (let i = 0; i < messages.length; i += 100) {
        await queue(name).sendBatch(
          messages.slice(i, i + 100).map((m) => ({
            body: m.body,
            ...(m.delaySeconds ? { delaySeconds: m.delaySeconds } : {}),
          })),
        )
      }
    },
  }
}
