import type { Lease, TelaDb } from '@tela/data'
import { bumpSeq, fence, isFenceRefusal, release } from '@tela/data'
import type { Blobs, Clock } from '@tela/platform'
import type { HttpClient } from '../http'
import type { RegionPolicy } from '../region-policy'

/** What a pipeline step runs against. Production: D1, R2, the Workers fetch client. */
export type IngestContext = {
  db: TelaDb
  blobs: Blobs
  http: HttpClient
  clock: Clock
  /** Jitter source for the next fetch time; tests pin it. */
  random?: () => number
  /** Relay routing; absent means feeds never change region. */
  region?: RegionPolicy
  /** Record WebSub hubs so the subscribe sweep follows them. */
  websub?: boolean
}

/** A statement for a batch (anything drizzle's batch accepts). */
export type Statement = Parameters<TelaDb['batch']>[0][number]

/**
 * Commit a step's writes as one fenced batch: the lease is checked first, the sync sequence
 * bumped, and the lease released last. Returns the batch results (fence and seq included), or
 * `lost` when the lease had expired and another holder owns the item: nothing was written.
 */
export async function commit(
  ctx: IngestContext,
  lease: Lease,
  statements: Statement[],
): Promise<{ ok: true; results: unknown[] } | { ok: false; reason: 'lost' }> {
  const { db } = ctx
  try {
    const results = await db.batch([
      fence(db, lease, ctx.clock.now()),
      bumpSeq(db),
      ...statements,
      release(db, lease),
    ] as unknown as Parameters<TelaDb['batch']>[0])
    return { ok: true, results: results as unknown as unknown[] }
  } catch (err) {
    if (isFenceRefusal(err)) return { ok: false, reason: 'lost' }
    throw err
  }
}
