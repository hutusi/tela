/**
 * What the people a member follows do (ADR 0031): the Following feed, and which of them read a
 * blog. By RPC, not sync: these are other members' rows, shown only as far as each chose to show
 * them, and that choice is applied here, when they are read.
 *
 * The feed pages by windows of local days rather than by a count of items: likes and new
 * subscriptions are grouped per person per day ("liked 3 posts"), and a window that starts at a
 * local midnight never cuts a group in two, so no page repeats or drops part of one.
 */
import { ARTICLE_COLUMNS } from '@tela/data'
import { isReadingLanguage } from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'

const DAY = 24 * 60 * 60 * 1000
/** Local days per page of the feed. */
export const WINDOW_DAYS = 14
/** Recommendations one page holds; past it, the page ends at a day boundary. */
export const MAX_RECOMMENDATIONS = 200
/** Posts shown of one day's likes, and blogs of one day's subscriptions. */
const LIKED_SHOWN = 5
const SUBSCRIBED_SHOWN = 3
const PUBLIC_LISTING = sql.raw(`('listed', 'featured')`)

export type FeedTab = 'all' | 'recs' | 'likes'

type Row = Record<string, unknown>

/** The viewer's offset from UTC in milliseconds, from minutes east (`tz`), within real zones. */
function offsetOf(tz: string | undefined): number {
  const minutes = Number(tz ?? 0)
  if (!Number.isInteger(minutes)) return 0
  return Math.max(-14 * 60, Math.min(14 * 60, minutes)) * 60_000
}

/** A post as the feed carries one: the article, its blog, and its title in the member's language. */
function postOf(r: Row) {
  const {
    siteId,
    siteTitle,
    homeUrl,
    listed,
    translatedTitle,
    translatedExcerpt,
    userId: _u,
    handle: _h,
    displayName: _d,
    at: _at,
    note: _note,
    n: _n,
    total: _t,
    day: _day,
    ...article
  } = r
  return {
    siteId,
    siteTitle,
    homeUrl,
    listed: listed === 1,
    translatedTitle: translatedTitle ?? null,
    translatedExcerpt: translatedExcerpt ?? null,
    article,
  }
}

const personOf = (r: Row) => ({
  id: String(r.userId),
  handle: String(r.handle),
  displayName: (r.displayName as string | null) ?? null,
})

export function socialRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  routes.get('/following', async (c) => {
    const me = c.get('member').id
    const asked = c.req.query('tab')
    const tab: FeedTab = asked === 'recs' || asked === 'likes' ? asked : 'all'
    const lang = isReadingLanguage(c.req.query('lang')) ? c.req.query('lang') : null
    const offset = offsetOf(c.req.query('tz'))
    const now = deps.clock.now()
    const given = Number(c.req.query('before'))
    const end = Number.isInteger(given) && given > 0 ? Math.min(given, now + 1) : now + 1
    const dayOf = (at: number) => Math.floor((at + offset) / DAY)
    const startOf = (day: number) => day * DAY - offset
    const start = startOf(dayOf(end - 1) - (WINDOW_DAYS - 1))
    const first = !(Number.isInteger(given) && given > 0)

    const followees = sql`select followee_id from follows where follower_id = ${me} and deleted_at is null`
    const translated = (column: 'title' | 'excerpt') =>
      sql`(select t.${sql.raw(column)} from article_titles t where t.article_id = a.id and t.lang = ${lang})`
    const post = sql`s.id as "siteId", s.title as "siteTitle", s.home_url as "homeUrl",
      (s.listing in ${PUBLIC_LISTING}) as listed, ${ARTICLE_COLUMNS},
      ${translated('title')} as "translatedTitle", ${translated('excerpt')} as "translatedExcerpt"`
    const who = sql`p.user_id as "userId", p.handle, p.display_name as "displayName"`
    // A local day's index. Cast, in case a driver binds the offset as a real: days are whole.
    const day = (column: SQL) => sql`cast((${column} + ${offset}) / ${DAY} as integer)`
    const none = sql`select 1 where false`
    /** An absent term of the union below, shaped like the others. */
    const noAt = sql`select null as at where false`
    const postOn = (articleId: SQL) => sql`join articles a on a.id = ${articleId}
      join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id`

    // Each source as the viewer may see it, from the people they follow only.
    const recsFrom = sql`recommendations r join profiles p on p.user_id = r.user_id`
    const recsWhere = sql`r.user_id in (${followees}) and r.deleted_at is null`
    const likesFrom = sql`user_article_states st join profiles p on p.user_id = st.user_id`
    const likesWhere = sql`st.user_id in (${followees}) and p.public_likes = 1
      and st.liked_at is not null`
    const subsFrom = sql`subscriptions sub join profiles p on p.user_id = sub.user_id
      join feeds f on f.id = sub.feed_id join sites s on s.id = f.site_id`
    const subsWhere = sql`sub.user_id in (${followees}) and p.public_subscriptions = 1
      and sub.deleted_at is null and s.listing in ${PUBLIC_LISTING}`
    const within = (column: SQL) => sql`and ${column} >= ${start} and ${column} < ${end}`
    const wantRecs = tab !== 'likes'
    const wantLikes = tab !== 'recs'
    const wantSubs = tab === 'all'

    const [recommended, liked, subscribed, older, suggested] = (await db.batch([
      wantRecs
        ? db.all(sql`
            select ${who}, r.note, r.created_at as at, ${post}
            from ${recsFrom} ${postOn(sql`r.article_id`)}
            where ${recsWhere} ${within(sql`r.created_at`)}
            order by r.created_at desc limit ${MAX_RECOMMENDATIONS}
          `)
        : db.all(none),
      wantLikes
        ? db.all(sql`
            select * from (
              select ${who}, st.liked_at as at, ${day(sql`st.liked_at`)} as day,
                row_number() over (partition by st.user_id, ${day(sql`st.liked_at`)}
                  order by st.liked_at desc) as n,
                count(*) over (partition by st.user_id, ${day(sql`st.liked_at`)}) as total,
                ${post}
              from ${likesFrom} ${postOn(sql`st.article_id`)}
              where ${likesWhere} ${within(sql`st.liked_at`)}
            ) where n <= ${LIKED_SHOWN}
          `)
        : db.all(none),
      wantSubs
        ? db.all(sql`
            select * from (
              select ${who}, sub.created_at as at, ${day(sql`sub.created_at`)} as day,
                row_number() over (partition by sub.user_id, ${day(sql`sub.created_at`)}
                  order by sub.created_at desc) as n,
                count(*) over (partition by sub.user_id, ${day(sql`sub.created_at`)}) as total,
                s.id, s.title, s.home_url as "homeUrl", s.description, s.favicon_key as "faviconKey",
                s.primary_lang as "primaryLang",
                (select min(f2.id) from feeds f2 where f2.site_id = s.id and f2.merged_into is null)
                  as "feedId"
              from ${subsFrom} where ${subsWhere} ${within(sql`sub.created_at`)}
            ) where n <= ${SUBSCRIBED_SHOWN}
          `)
        : db.all(none),
      // Whether anything is older than this window, and when: the next page ends that day.
      db.all(sql`
        select max(at) as at from (
          ${wantRecs ? sql`select max(r.created_at) as at from ${recsFrom} where ${recsWhere} and r.created_at < ${start}` : noAt}
          union all
          ${wantLikes ? sql`select max(st.liked_at) as at from ${likesFrom} where ${likesWhere} and st.liked_at < ${start}` : noAt}
          union all
          ${wantSubs ? sql`select max(sub.created_at) as at from ${subsFrom} where ${subsWhere} and sub.created_at < ${start}` : noAt}
        )
      `),
      // Readers to follow, on the first page only, from what is public: people who recommended
      // posts from blogs the member reads, people whose shown subscriptions overlap theirs, and
      // people recommending lately (ADR 0031).
      first
        ? db.all(sql`
            select p.user_id as id, p.handle, p.display_name as "displayName", p.bio,
              count(*) as score
            from (
              select r.user_id from recommendations r join articles a on a.id = r.article_id
              where r.deleted_at is null and a.feed_id in (
                select feed_id from subscriptions where user_id = ${me} and deleted_at is null)
              union all
              select sub.user_id from subscriptions sub join profiles q on q.user_id = sub.user_id
              where q.public_subscriptions = 1 and sub.deleted_at is null and sub.feed_id in (
                select feed_id from subscriptions where user_id = ${me} and deleted_at is null)
              union all
              select r.user_id from recommendations r
              where r.deleted_at is null and r.created_at >= ${now - 30 * DAY}
            ) candidates join profiles p on p.user_id = candidates.user_id
            where p.user_id <> ${me} and p.user_id not in (${followees})
            group by p.user_id order by score desc, p.handle limit 5
          `)
        : db.all(none),
    ] as never)) as unknown as Row[][]

    type Item =
      | {
          kind: 'recommended'
          at: number
          person: ReturnType<typeof personOf>
          note: string | null
          post: ReturnType<typeof postOf>
        }
      | {
          kind: 'liked'
          at: number
          person: ReturnType<typeof personOf>
          count: number
          posts: ReturnType<typeof postOf>[]
        }
      | {
          kind: 'subscribed'
          at: number
          person: ReturnType<typeof personOf>
          count: number
          sites: Row[]
        }
    let items: Item[] = (recommended ?? []).map((r) => ({
      kind: 'recommended' as const,
      at: Number(r.at),
      person: personOf(r),
      note: (r.note as string | null) ?? null,
      post: postOf(r),
    }))
    /** Rows of one person's day, newest first, as one item. */
    const grouped = (rows: Row[]) => {
      const groups = new Map<string, Row[]>()
      for (const r of rows) {
        const key = `${r.userId}:${r.day}`
        groups.set(key, [...(groups.get(key) ?? []), r])
      }
      return [...groups.values()].map((g) => g.sort((a, b) => Number(b.at) - Number(a.at)))
    }
    for (const g of grouped(liked ?? [])) {
      const head = g[0] as Row
      items.push({
        kind: 'liked',
        at: Number(head.at),
        person: personOf(head),
        count: Number(head.total),
        posts: g.map(postOf),
      })
    }
    for (const g of grouped(subscribed ?? [])) {
      const head = g[0] as Row
      items.push({
        kind: 'subscribed',
        at: Number(head.at),
        person: personOf(head),
        count: Number(head.total),
        sites: g.map(
          ({
            userId: _u,
            handle: _h,
            displayName: _d,
            at,
            n: _n,
            total: _t,
            day: _day,
            ...site
          }) => ({
            ...site,
            subscribedAt: at,
          }),
        ),
      })
    }

    // Where the next page ends: the end of the day of the newest thing older than this window.
    // A window with more recommendations than a page holds ends at the day of the oldest one
    // held, which the next page repeats whole: what this page shows of that day goes.
    const olderAt = Number(older?.[0]?.at)
    let next: number | null =
      Number.isFinite(olderAt) && olderAt > 0 ? startOf(dayOf(olderAt) + 1) : null
    const oldestRec = recommended?.at(-1)
    if ((recommended?.length ?? 0) >= MAX_RECOMMENDATIONS && oldestRec) {
      const cut = dayOf(Number(oldestRec.at))
      if (cut > dayOf(start)) {
        items = items.filter((i) => dayOf(i.at) > cut)
        next = startOf(cut + 1)
      }
    }
    items.sort((a, b) => b.at - a.at)

    return c.json(
      {
        items,
        next,
        suggested: (suggested ?? []).map(({ score: _s, ...p }) => p),
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  /**
   * The people the member follows who read a blog, as far as they show what they read. Beside
   * the blog's public page, which the edge caches for everyone, never in it.
   */
  routes.get('/sites/:siteId/followed-readers', async (c) => {
    const me = c.get('member').id
    const siteId = Number(c.req.param('siteId'))
    if (!Number.isInteger(siteId)) return c.json({ readers: [] })
    const readers = await db.all<Row>(sql`
      select distinct p.user_id as id, p.handle, p.display_name as "displayName"
      from follows fo join profiles p on p.user_id = fo.followee_id
      join subscriptions sub on sub.user_id = fo.followee_id and sub.deleted_at is null
      join feeds f on f.id = sub.feed_id
      where fo.follower_id = ${me} and fo.deleted_at is null and p.public_subscriptions = 1
        and f.site_id = ${siteId}
      order by p.handle limit 12
    `)
    return c.json({ readers }, 200, { 'cache-control': 'no-store' })
  })

  return routes
}
