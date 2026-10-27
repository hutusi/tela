/**
 * The day's limit on posts opened from blogs a member does not follow (ADR 0066): whether a member
 * may have these content objects now. Both edges ask it before they serve a body, a translation of
 * one, or an image it names: tela-web for a session, tela-gateway for an app's token, through
 * tela-api, so one count holds for the web and every app.
 */
import type { OpensDecision, OpensRefusal } from '@tela/shared'
import { sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import type { Actor } from './actor'
import { settingSql } from './settings'
import { nextUtcMidnight, utcDay } from './translation'

export type AdmitOpens = Actor & {
  /** Content keys, 32 hex characters each: at most a bundle's worth (`OPENS_KEYS_MAX`). */
  keys: string[]
  now: number
}

/**
 * Decide in one batch which of `keys` the member may have, and count the ones that cost a place:
 *
 * - a key some version of a post in a feed they subscribe to now holds is free;
 * - a key they opened already today is free again;
 * - a key no post holds is free too, and not written: there is nothing behind it to serve, and a
 *   mistyped or invented key must not spend a place, nor grow the table while the limit is off;
 * - any other key, a post kept (liked, recommended, highlighted) from a blog they left included,
 *   is a row in `post_opens`, written only while the day's count is under
 *   `member.unsubscribedPostsPerDay`, in the order given, so a bundle that crosses the limit takes
 *   the places left and is refused the rest.
 *
 * The count is read inside the insert, which one statement makes atomic: two decisions racing
 * (two tabs, the web and an app) cannot both take the last place. `exempt` (an admin on the web,
 * never an app) is allowed everything and writes nothing.
 */
export async function admitOpens(db: TelaDb, input: AdmitOpens): Promise<OpensDecision> {
  const keys = [...new Set(input.keys)]
  if (keys.length === 0 || input.exempt) return { allowed: keys, refused: {} }
  const day = utcDay(input.now)
  // The ask, bound once each, and every key with what decides it. A version's key counts as its
  // post's: a device may still hold the key of the version before a reprocess.
  const header = sql`with a(me, d, n, lim) as (
      select ${input.userId}, ${day}, ${input.now}, ${settingSql('member.unsubscribedPostsPerDay')}
    ),
    k(ord, ck, sub, known) as (
      select j.key, j.value,
        exists (select 1 from article_versions v
          join articles r on r.id = v.article_id
          join subscriptions s on s.feed_id = r.feed_id
          where v.content_key = j.value and s.user_id = a.me and s.deleted_at is null)
        or exists (select 1 from articles r
          join subscriptions s on s.feed_id = r.feed_id
          where r.content_key = j.value and s.user_id = a.me and s.deleted_at is null),
        exists (select 1 from article_versions v where v.content_key = j.value)
        or exists (select 1 from articles r where r.content_key = j.value)
      from json_each(${JSON.stringify(keys)}) j, a
    )`
  const opened = sql`exists (select 1 from post_opens o
    where o.user_id = a.me and o.day = a.d and o.content_key = k.ck)`
  const [, rows] = (await db.batch([
    db.run(sql`
      ${header},
      c(ck, rn) as (
        select k.ck, row_number() over (order by k.ord) from k, a
        where not k.sub and k.known and not ${opened}
      )
      insert into post_opens (user_id, day, content_key, opened_at)
      select a.me, a.d, c.ck, a.n from c, a
      where a.lim is null or c.rn <= a.lim - (select count(*) from post_opens o
        where o.user_id = a.me and o.day = a.d)
      on conflict (user_id, day, content_key) do nothing
    `),
    db.all(sql`
      ${header}
      select k.ck as ck, (k.sub or not k.known or ${opened}) as ok, a.lim as lim
      from k, a order by k.ord
    `),
  ] as never)) as unknown as [unknown, { ck: string; ok: unknown; lim: unknown }[]]
  const decision: OpensDecision = { allowed: [], refused: {} }
  const resetsAt = nextUtcMidnight(input.now)
  for (const row of rows) {
    if (row.ok === 1 || row.ok === true) {
      decision.allowed.push(row.ck)
      continue
    }
    const refusal: OpensRefusal = { error: 'post_limit', limit: Number(row.lim ?? 0), resetsAt }
    decision.refused[row.ck] = refusal
  }
  return decision
}

/**
 * How many posts from blogs they do not follow the member opened on the UTC day of `now`: what
 * their usage shows beside `member.unsubscribedPostsPerDay`.
 */
export async function opensToday(db: TelaDb, userId: string, now: number): Promise<number> {
  const rows = await db.all<{ n: number }>(
    sql`select count(*) as n from post_opens where user_id = ${userId} and day = ${utcDay(now)}`,
  )
  return Number(rows[0]?.n ?? 0)
}
