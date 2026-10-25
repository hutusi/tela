/**
 * What an ordinary account may add (ADR 0063): feeds new to Tela per UTC day
 * (`member.feedsPerDay`) and subscriptions held (`member.maxSubscriptions`). Each is SQL that a
 * statement enforces inline, reading the setting as it runs, so a limit is never older than the
 * write it guards and two writes cannot both take its last place. An admin is exempt from both;
 * nothing here touches the site budget or the hourly limits in `limits.ts`.
 *
 * A room is how many more the member may add: `NO_LIMIT` when nothing bounds it, so it can stand
 * in `min()` and in a `LIMIT` as it is.
 *
 * Feeds new to Tela an import names beyond the member's day wait in `pending_feeds`, and
 * `member.pendingFeeds` adds them on the days after, by the same statements as the import.
 */
import { type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { fence, type Lease, release } from '../leases'
import { bumpSeq, currentSeq } from '../seq'
import { settingSql } from './settings'
import { utcDayStart } from './signup'
import { recountReaders } from './sites'
import { standingOk } from './standing'
import { utcDay } from './translation'

/** Room nothing bounds: more than any count, and still a valid `LIMIT`. */
export const NO_LIMIT = 1_000_000_000

/** A member named by id, or by a column of the query around it (a due query's `p.user_id`). */
type Who = string | SQL
const who = (member: Who): SQL => (typeof member === 'string' ? sql`${member}` : member)

/** True (as SQL) for an admin, whom a member's limits do not bound. */
export const exemptFromLimits = (member: Who): SQL =>
  sql`exists (select 1 from profiles where user_id = ${who(member)} and is_admin = 1)`

/** Feeds new to Tela the member added since the UTC day of `now` began, by URL or by claim. */
export const feedsAddedToday = (member: Who, now: number): SQL =>
  sql`(select count(*) from feeds where added_by = ${who(member)}
    and created_at >= ${utcDayStart(now)})`

/** Subscriptions the member holds. */
export const subscriptionsHeld = (member: Who): SQL =>
  sql`(select count(*) from subscriptions where user_id = ${who(member)} and deleted_at is null)`

/** How many more feeds new to Tela the member may add today. */
export function feedRoom(member: Who, now: number): SQL {
  const limit = settingSql('member.feedsPerDay')
  return sql`(case when ${exemptFromLimits(member)} or ${limit} is null then ${NO_LIMIT}
    else max(0, ${limit} - ${feedsAddedToday(member, now)}) end)`
}

/** How many more subscriptions the member may hold. */
export function subscriptionRoom(member: Who): SQL {
  const limit = settingSql('member.maxSubscriptions')
  return sql`(case when ${exemptFromLimits(member)} or ${limit} is null then ${NO_LIMIT}
    else max(0, ${limit} - ${subscriptionsHeld(member)}) end)`
}

/** A feed a member brings: its URL, host, the origin a new one's placeholder site is keyed by. */
export type BroughtFeed = { feedUrl: string; host: string; origin: string; title?: string | null }

/** What bringing feeds did. */
export type Brought = {
  /** Subscriptions made or revived. */
  subscribed: number
  /** Feeds new to Tela added (and subscribed). */
  added: number
  /** Feeds now waiting for a later day, this import's and earlier ones'. */
  waiting: number
  /** Of the feeds brought, how many the member now follows. */
  following: number
  /** Of the feeds brought, how many neither follow nor wait: past the subscription cap. */
  over: number
  /** `member.feedsPerDay` and `member.maxSubscriptions` as they held, and whether the member is exempt. */
  perDay: number | null
  maxSubscriptions: number | null
  exempt: boolean
}

/**
 * The statements that bring `feeds` to the member, in the document's order: each feed Tela has
 * subscribes, free; then as many new ones as both the day and the cap leave room for are added
 * under a placeholder site, as an import always added them, and subscribed. With `queue`, the new
 * ones left wait in `pending_feeds`, as many as the cap leaves room for beside those already
 * waiting; past the cap, a feed is left out. Without, they are the member's waiting rows, and those
 * the member now follows stop waiting.
 *
 * Subscribing before adding is what keeps a feed Tela has from waiting on a day's allowance, and
 * the second subscribe is the same statement: the first took every known feed it had room for,
 * so it finds only the feeds just added. A merged feed's URL subscribes to the feed it merged
 * into (ADR 0028). The caller's batch writes synced rows, so it starts with `bumpSeq`.
 */
function bringStatements(
  db: TelaDb,
  input: { userId: string; feeds: BroughtFeed[]; now: number; queue: boolean },
) {
  const { userId, now } = input
  const rows = JSON.stringify(
    input.feeds.map((f) => [f.feedUrl, f.host, f.origin, f.title ?? null]),
  )
  const isNew = sql`not exists (select 1 from feeds f where f.feed_url = j.value->>0)`
  // As many new ones as the day and the cap leave room for, in the document's order: the site and
  // the feed statements pick the same ones, since a site written changes neither room.
  const fresh = sql`(select j.value->>0 as url, j.value->>1 as host, j.value->>2 as origin
    from json_each(${rows}) j where ${isNew} order by j.key
    limit min(${feedRoom(userId, now)}, ${subscriptionRoom(userId)}))`
  const follow = () =>
    db.all(sql`
    insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at, seq)
    select ${userId}, k.feed_id, 0, ${now}, ${now}, ${currentSeq} from (
      select coalesce(f.merged_into, f.id) as feed_id, min(j.key) as ord
      from json_each(${rows}) j join feeds f on f.feed_url = j.value->>0
      where not exists (select 1 from subscriptions s where s.user_id = ${userId}
        and s.feed_id = coalesce(f.merged_into, f.id) and s.deleted_at is null)
      group by 1 order by ord limit ${subscriptionRoom(userId)}
    ) k
    where true
    on conflict (user_id, feed_id) do update set
      deleted_at = null, updated_at = excluded.updated_at, seq = excluded.seq
    where subscriptions.deleted_at is not null
    returning feed_id
  `)
  const followed = sql`exists (select 1 from feeds f
    join subscriptions s on s.feed_id = coalesce(f.merged_into, f.id)
    where f.feed_url = j.value->>0 and s.user_id = ${userId} and s.deleted_at is null)`
  const waits = sql`exists (select 1 from pending_feeds p
    where p.user_id = ${userId} and p.feed_url = j.value->>0)`
  return [
    follow(),
    db.run(sql`
      insert into sites (home_url, created_at, updated_at, seq)
      select distinct n.origin, ${now}, ${now}, ${currentSeq} from ${fresh} n
      where true
      on conflict (home_url) do nothing
    `),
    db.all(sql`
      insert into feeds (site_id, feed_url, host, next_fetch_at, added_by, created_at, updated_at, seq)
      select s.id, n.url, n.host, ${now}, ${userId}, ${now}, ${now}, ${currentSeq}
      from ${fresh} n join sites s on s.home_url = n.origin
      where true
      on conflict (feed_url) do nothing
      returning id
    `),
    follow(),
    ...recountReaders(
      db,
      sql`select distinct coalesce(t.site_id, f.site_id) from feeds f
        left join feeds t on t.id = f.merged_into
        where f.feed_url in (select value->>0 from json_each(${rows}))`,
      now,
    ),
    input.queue
      ? db.run(sql`
          insert into pending_feeds (user_id, feed_url, title, queued_at)
          select ${userId}, w.url, w.title, ${now} from (
            select j.value->>0 as url, j.value->>3 as title from json_each(${rows}) j
            where ${isNew} and not ${waits} order by j.key
            limit max(0, ${subscriptionRoom(userId)}
              - (select count(*) from pending_feeds where user_id = ${userId}))
          ) w
          where true
          on conflict (user_id, feed_url) do nothing
        `)
      : db.run(sql`
          delete from pending_feeds where user_id = ${userId}
            and feed_url in (select j.value->>0 from json_each(${rows}) j where ${followed})
        `),
    db.all(sql`
      select
        (select count(*) from pending_feeds where user_id = ${userId}) as waiting,
        (select count(*) from json_each(${rows}) j where ${followed}) as following,
        (select count(*) from json_each(${rows}) j where not ${followed} and not ${waits}) as over,
        ${settingSql('member.feedsPerDay')} as per_day,
        ${settingSql('member.maxSubscriptions')} as max_subscriptions,
        ${exemptFromLimits(userId)} as exempt
    `),
  ] as const
}

type Summary = {
  waiting: number
  following: number
  over: number
  per_day: number | null
  max_subscriptions: number | null
  exempt: number
}

function readBrought(results: unknown[], from: number): Brought {
  const rows = (i: number) => results[from + i] as unknown[]
  const summary = rows(7)[0] as Summary
  return {
    subscribed: rows(0).length + rows(3).length,
    added: rows(2).length,
    waiting: Number(summary.waiting),
    following: Number(summary.following),
    over: Number(summary.over),
    perDay: summary.per_day === null ? null : Number(summary.per_day),
    maxSubscriptions: summary.max_subscriptions === null ? null : Number(summary.max_subscriptions),
    exempt: Boolean(summary.exempt),
  }
}

/** One feed per URL, the first listed: a URL twice would take two of the day's places. */
function unique(feeds: BroughtFeed[]): BroughtFeed[] {
  const seen = new Set<string>()
  return feeds.filter((f) => !seen.has(f.feedUrl) && seen.add(f.feedUrl))
}

/**
 * An OPML import (ADR 0063): every feed Tela has subscribed, as many new ones as the member's day
 * leaves room for added, the rest waiting for `member.pendingFeeds`, all within the subscription
 * cap. One batch, whatever the count: nothing is fetched here, so nothing is verified, and a URL
 * that is not a feed fails its first fetch and dies like any other dead feed.
 */
export async function importFeeds(
  db: TelaDb,
  input: { userId: string; feeds: BroughtFeed[]; now: number },
): Promise<Brought> {
  const statements = bringStatements(db, { ...input, feeds: unique(input.feeds), queue: true })
  const results = (await db.batch([bumpSeq(db), ...statements] as never)) as unknown[]
  return readBrought(results, 1)
}

/**
 * The member's waiting feeds, as `member.pendingFeeds` takes them: the oldest first, a day's worth
 * at most of an import's size.
 */
export function pendingFeedsOf(db: TelaDb, userId: string, limit = 500) {
  return db.all<{ feed_url: string; title: string | null }>(sql`
    select feed_url, title from pending_feeds where user_id = ${userId}
    order by queued_at, feed_url limit ${limit}
  `)
}

/**
 * A member out of good standing (ADRs 0058, 0059), as SQL over the member's id. A member with no
 * profile is not, as `isBarred` has it.
 */
const barred = (member: SQL | string) => sql`exists (select 1 from profiles pr
  where pr.user_id = ${member} and not ${standingOk('pr')})`

/**
 * Add what the member's day now leaves room for of their waiting feeds, under the lease that took
 * them: one fenced batch, so a holder that lost its lease adds nothing. A waiting feed someone else
 * added meanwhile subscribes free. `drop` names waiting URLs that cannot be added at all (no
 * origin), which stop waiting. A member suspended or closed while the run read their rows is
 * refused as a lost lease is, by the fence's own table: nothing is added for them.
 */
export async function addPendingFeeds(
  db: TelaDb,
  input: { lease: Lease; userId: string; feeds: BroughtFeed[]; drop: string[]; now: number },
): Promise<Brought> {
  const statements = bringStatements(db, {
    userId: input.userId,
    feeds: unique(input.feeds),
    now: input.now,
    queue: false,
  })
  const results = (await db.batch([
    fence(db, input.lease, input.now),
    db.run(sql`insert into lease_fence (x) select null where ${barred(input.userId)}`),
    bumpSeq(db),
    ...statements,
    db.run(sql`
      delete from pending_feeds where user_id = ${input.userId}
        and feed_url in (select value from json_each(${JSON.stringify(input.drop)}))
    `),
    release(db, input.lease),
  ] as never)) as unknown[]
  return readBrought(results, 3)
}

/**
 * Members with feeds waiting that a run would move now (`member.pendingFeeds`), oldest wait first:
 * their day has room and so has their cap, or a feed they wait for is one Tela has now, or one
 * they follow already. A wait an exhausted run pushed past `now` waits until then. A suspended
 * member's wait is kept and not swept, so lifting the suspension brings their feeds on; a closed
 * account's was dropped as it closed.
 */
export function duePendingFeeds(now: number): SQL {
  const member = sql`p.user_id`
  const known = sql`exists (select 1 from pending_feeds q join feeds f on f.feed_url = q.feed_url
    where q.user_id = p.user_id)`
  return sql`select p.user_id as key, null as host, min(p.queued_at) as ord
    from pending_feeds p
    where not ${barred(member)}
    group by p.user_id
    having min(p.queued_at) <= ${now}
      and (${subscriptionRoom(member)} > 0 and (${feedRoom(member, now)} > 0 or ${known})
        or exists (select 1 from pending_feeds q join feeds f on f.feed_url = q.feed_url
          join subscriptions s on s.feed_id = coalesce(f.merged_into, f.id)
          where q.user_id = p.user_id and s.user_id = p.user_id and s.deleted_at is null))`
}

/**
 * Subscribe the member to one feed, unless they hold as many as the cap allows: true when they
 * follow it after. Statements for a batch that bumps the sync sequence and recounts the feed's
 * site.
 */
export function subscribeWithinCap(db: TelaDb, userId: string, feedId: number, now: number) {
  return db.all(sql`
    insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at, seq)
    select ${userId}, ${feedId}, 0, ${now}, ${now}, ${currentSeq}
    where ${subscriptionRoom(userId)} > 0
      or exists (select 1 from subscriptions where user_id = ${userId} and feed_id = ${feedId}
        and deleted_at is null)
    on conflict (user_id, feed_id) do update set
      deleted_at = null, updated_at = excluded.updated_at, seq = excluded.seq
    where subscriptions.deleted_at is not null
    returning feed_id
  `)
}

/** The member's allowances as their usage answer gives them (`GET /api/v1/account/usage`). */
export type MemberAllowances = {
  exempt: boolean
  feeds: { perDay: number | null; addedToday: number; pending: number }
  subscriptions: { max: number | null; count: number }
  translations: { perDay: number | null; usedToday: number; waiting: number }
}

/** What the member has used of each allowance, in one read. */
export async function memberAllowances(
  db: TelaDb,
  userId: string,
  now: number,
): Promise<MemberAllowances> {
  const day = utcDay(now)
  const rows = await db.all<{
    exempt: number
    feeds_per_day: number | null
    added_today: number
    pending: number
    max_subscriptions: number | null
    subscriptions: number
    translations_per_day: number | null
    used_today: number
    waiting: number
  }>(sql`
    select
      ${exemptFromLimits(userId)} as exempt,
      ${settingSql('member.feedsPerDay')} as feeds_per_day,
      ${feedsAddedToday(userId, now)} as added_today,
      (select count(*) from pending_feeds where user_id = ${userId}) as pending,
      ${settingSql('member.maxSubscriptions')} as max_subscriptions,
      ${subscriptionsHeld(userId)} as subscriptions,
      ${settingSql('member.translationsPerDay')} as translations_per_day,
      coalesce((select requests from usage_daily where subject = ${userId} and day = ${day}), 0)
        as used_today,
      (select count(*) from body_translations where requested_by = ${userId}
        and state = 'requested' and due_at > ${now}) as waiting
  `)
  const r = rows[0]
  if (!r) throw new Error('the allowance read returned no row')
  const limit = (v: number | null) => (v === null ? null : Number(v))
  return {
    exempt: Boolean(r.exempt),
    feeds: {
      perDay: limit(r.feeds_per_day),
      addedToday: Number(r.added_today),
      pending: Number(r.pending),
    },
    subscriptions: { max: limit(r.max_subscriptions), count: Number(r.subscriptions) },
    translations: {
      perDay: limit(r.translations_per_day),
      usedToday: Number(r.used_today),
      waiting: Number(r.waiting),
    },
  }
}
