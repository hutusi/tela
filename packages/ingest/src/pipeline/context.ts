import type { Lease, TelaDb } from '@tela/data'
import { bumpSeq, fence, isFenceRefusal, release } from '@tela/data'
import type { Blobs, Clock } from '@tela/platform'
import { sql } from 'drizzle-orm'
import type { GitHub } from '../github'
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
  /** Public asset store (favicons), served at assets.<domain>; absent disables the assets job. */
  assets?: Blobs
  /** Public origin of the web app: claim `rel="me"` targets and the WebSub callback. */
  publicUrl?: string
  /** Where Gravatar serves pictures (ADR 0033); unset is `GRAVATAR_URL`. Tests point it here. */
  gravatarUrl?: string
  /** GitHub's public profiles, for a claim by GitHub (ADR 0045); absent, no claim checks GitHub. */
  github?: GitHub
  /** Tests only: let side requests the HTTP client does not make (WebSub hubs) reach localhost. */
  allowPrivateHosts?: boolean
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
  /** Keep the lease for more work (a translation's next chunk) instead of releasing it. */
  options: { hold?: { ttlMs: number } } = {},
): Promise<{ ok: true; results: unknown[] } | { ok: false; reason: 'lost' }> {
  const { db } = ctx
  const now = ctx.clock.now()
  const last = options.hold
    ? db.run(sql`
        update leases set until = ${now + options.hold.ttlMs}
        where kind = ${lease.kind} and key = ${lease.key} and owner = ${lease.owner}
      `)
    : release(db, lease)
  try {
    const results = await db.batch([
      fence(db, lease, now),
      bumpSeq(db),
      ...statements,
      last,
    ] as unknown as Parameters<TelaDb['batch']>[0])
    return { ok: true, results: results as unknown as unknown[] }
  } catch (err) {
    if (isFenceRefusal(err)) return { ok: false, reason: 'lost' }
    throw err
  }
}
