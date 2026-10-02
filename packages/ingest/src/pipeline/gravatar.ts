/**
 * Whether Gravatar has a picture for a member (ADR 0033): asked here, in the background, so the
 * reader never asks for a picture that is not there. Only the answer is kept; the picture itself
 * is fetched by tela-api when a page first shows it, and cached at the edge.
 */
import { sha256Hex } from '@tela/content/hash'
import { currentSeq, first, gravatarOn, type Lease } from '@tela/data'
import { GRAVATAR_URL } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { HttpError } from '../http'
import { commit, type IngestContext } from './context'

/** Small: only the answer matters, and Gravatar renders any size it is asked for. */
const SIZE = 80
const MAX_BYTES = 256 * 1024

export type GravatarCheck =
  | { status: 'done'; found: boolean }
  | { status: 'skipped' | 'lost' }
  | { status: 'retry'; error: string }

/**
 * Ask Gravatar about one member's address, hashed as it hashes them (SHA-256 of the trimmed,
 * lower-cased email). A 200 is a picture and a 404 none (`d=404`); anything else is asked again
 * after a backoff. When the answer turns to a picture the version moves, so a "none" a cache kept
 * under the old address cannot stand; the row is sent again only when the answer changed.
 */
export async function gravatarCheckJob(ctx: IngestContext, lease: Lease): Promise<GravatarCheck> {
  const member = await first<{ email: string }>(
    ctx.db,
    sql`select u.email from profiles p join "user" u on u.id = p.user_id
      where p.user_id = ${lease.key} and ${gravatarOn('p')}`,
  )
  // Gone, or turned off since it was claimed: nothing to ask.
  if (!member) {
    const committed = await commit(ctx, lease, [])
    return committed.ok ? { status: 'skipped' } : { status: 'lost' }
  }
  const hash = await sha256Hex(member.email.trim().toLowerCase())
  const base = (ctx.gravatarUrl ?? GRAVATAR_URL).replace(/\/+$/, '')
  let status: number
  try {
    const res = await ctx.http.get(`${base}/${hash}?s=${SIZE}&d=404`, {
      accept: 'image/*',
      region: 'global',
      maxBytes: MAX_BYTES,
    })
    status = res.status
  } catch (err) {
    if (err instanceof HttpError) return { status: 'retry', error: `${err.kind}: ${err.message}` }
    throw err
  }
  if (status !== 200 && status !== 404) return { status: 'retry', error: `http ${status}` }
  const found = status === 200 ? 1 : 0
  const now = ctx.clock.now()
  // Every SET reads the row as it was, so `gravatar_found` here is the answer before this one.
  const committed = await commit(ctx, lease, [
    ctx.db.run(sql`
      update profiles set
        avatar_version = case when ${found} = 1 and coalesce(gravatar_found, 0) = 0
          then avatar_version + 1 else avatar_version end,
        seq = case when gravatar_found is ${found} then seq else ${currentSeq} end,
        gravatar_found = ${found}, gravatar_checked_at = ${now}
      where user_id = ${lease.key}
    `),
  ])
  return committed.ok ? { status: 'done', found: found === 1 } : { status: 'lost' }
}
