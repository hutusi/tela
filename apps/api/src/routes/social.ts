/**
 * What the people a member follows do (ADR 0031): the Following feed, and which of them read a
 * blog. By RPC, not sync: these are other members' rows, shown only as far as each chose to show
 * them, and that choice is applied here, when they are read.
 *
 * The feed pages by count, newest first, behind a cursor of (time, offset, key). A recommendation
 * is an entry of its own. Likes and new subscriptions are grouped per person per local day ("liked
 * 3 posts"), and a group is placed at its newest event, computed over the whole day whatever the
 * cursor: so a group always lands whole on exactly one page, a busy day pages through like any
 * other, and activity of any age is on the first page when it is the newest there is. The offset
 * is the one the walk began under, so all its pages agree on where a day starts.
 */
import { ARTICLE_COLUMNS, avatarOf } from '@tela/data'
import { isReadingLanguage } from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'

const DAY = 24 * 60 * 60 * 1000
/** Entries per page of the feed: recommendations, and days of likes or subscriptions. */
export const PAGE_ENTRIES = 30
/** Posts shown of one day's likes, and blogs of one day's subscriptions. */
const LIKED_SHOWN = 5
const SUBSCRIBED_SHOWN = 3
const PUBLIC_LISTING = sql.raw(`('listed', 'featured')`)
/**
 * Where a page ends: an entry's time, the viewer's offset the page was grouped under, and the
 * entry's key for entries at the same millisecond. The offset rides in the cursor so every page of
 * one walk groups days alike, whatever the device's clock does between them (a DST change).
 */
const CURSOR = /^(\d{1,15}):(-?\d{1,4}):([rls]:[A-Za-z0-9_:-]{1,160})$/

export type FeedTab = 'all' | 'recs' | 'likes'

type Row = Record<string, unknown>

/** The viewer's offset from UTC in minutes east (`tz`), within real zones. */
function minutesOf(tz: string | undefined): number {
  const minutes = Number(tz ?? 0)
  if (!Number.isInteger(minutes)) return 0
  return Math.max(-14 * 60, Math.min(14 * 60, minutes))
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
    k: _k,
    groupAt: _g,
    rank: _r,
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
  avatar: (r.avatar as string | null) ?? null,
})

/** Newest first, then by key: the order pages are cut in, the same in SQL and here (ASCII keys). */
const newestFirst = (a: { at: number; key: string }, b: { at: number; key: string }) =>
  b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)

export function socialRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  routes.get('/following', async (c) => {
    const me = c.get('member').id
    const asked = c.req.query('tab')
    const tab: FeedTab = asked === 'recs' || asked === 'likes' ? asked : 'all'
    const lang = isReadingLanguage(c.req.query('lang')) ? c.req.query('lang') : null
    const now = deps.clock.now()
    const cursor = CURSOR.exec(c.req.query('cursor') ?? '')
    const first = cursor === null
    const minutes = minutesOf(cursor ? cursor[2] : c.req.query('tz'))
    const offset = minutes * 60_000
    // Entries strictly after the cursor in the feed's order: older, or as old with a smaller key.
    const after = (at: SQL, key: SQL) =>
      cursor
        ? sql`(${at} < ${Number(cursor[1])} or (${at} = ${Number(cursor[1])} and ${key} < ${cursor[3]}))`
        : sql`true`

    const followees = sql`select followee_id from follows where follower_id = ${me} and deleted_at is null`
    const translated = (column: 'title' | 'excerpt') =>
      sql`(select t.${sql.raw(column)} from article_titles t where t.article_id = a.id and t.lang = ${lang})`
    const post = sql`s.id as "siteId", s.title as "siteTitle", s.home_url as "homeUrl",
      (s.listing in ${PUBLIC_LISTING}) as listed, ${ARTICLE_COLUMNS},
      ${translated('title')} as "translatedTitle", ${translated('excerpt')} as "translatedExcerpt"`
    const who = sql`p.user_id as "userId", p.handle, p.display_name as "displayName",
      ${avatarOf('p')} as avatar`
    // A local day's index. Cast, in case a driver binds the offset as a real: days are whole.
    const day = (column: SQL) => sql`cast((${column} + ${offset}) / ${DAY} as integer)`
    const none = sql`select 1 where false`
    const postOn = (articleId: SQL) => sql`join articles a on a.id = ${articleId}
      join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id`
    const over = PAGE_ENTRIES + 1

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

    /**
     * One person's day of `rows` as groups: each placed at its newest event over the whole day
     * (`groupAt`), so the cursor never splits one; then the first `over` groups after the cursor,
     * with at most `shown` rows each, the newest first.
     */
    const grouped = (input: {
      prefix: string
      who: SQL
      at: SQL
      partition: SQL
      tiebreak: SQL
      columns: SQL
      from: SQL
      shown: number
    }) => {
      const d = day(input.at)
      const g = sql`partition by ${input.partition}, ${d}`
      return sql`
        select * from (
          select x.*, dense_rank() over (order by x."groupAt" desc, x.k desc) as rank from (
            select ${input.who}, ${input.at} as at, ${d} as day,
              ${input.prefix} || ${input.partition} || ':' || ${d} as k,
              max(${input.at}) over (${g}) as "groupAt",
              count(*) over (${g}) as total,
              row_number() over (${g} order by ${input.at} desc, ${input.tiebreak} desc) as n,
              ${input.columns}
            from ${input.from}
          ) x where x.n <= ${input.shown} and ${after(sql`x."groupAt"`, sql`x.k`)}
        ) where rank <= ${over}
        order by "groupAt" desc, k desc, n`
    }

    const wantRecs = tab !== 'likes'
    const wantLikes = tab !== 'recs'
    const wantSubs = tab === 'all'

    const [recommended, liked, subscribed, suggested] = (await db.batch([
      wantRecs
        ? db.all(sql`
            select * from (
              select ${who}, r.note, r.created_at as at, 'r:' || printf('%012d', r.id) as k, ${post}
              from ${recsFrom} ${postOn(sql`r.article_id`)}
              where ${recsWhere}
            ) where ${after(sql`at`, sql`k`)}
            order by at desc, k desc limit ${over}
          `)
        : db.all(none),
      wantLikes
        ? db.all(
            grouped({
              prefix: 'l:',
              who,
              at: sql`st.liked_at`,
              partition: sql`st.user_id`,
              tiebreak: sql`st.article_id`,
              columns: post,
              from: sql`${likesFrom} ${postOn(sql`st.article_id`)} where ${likesWhere}`,
              shown: LIKED_SHOWN,
            }) as never,
          )
        : db.all(none),
      wantSubs
        ? db.all(
            grouped({
              prefix: 's:',
              who,
              at: sql`sub.created_at`,
              partition: sql`sub.user_id`,
              tiebreak: sql`s.id`,
              columns: sql`s.id, s.title, s.home_url as "homeUrl", s.description,
                s.favicon_key as "faviconKey", s.primary_lang as "primaryLang",
                (select min(f2.id) from feeds f2 where f2.site_id = s.id and f2.merged_into is null)
                  as "feedId"`,
              from: sql`${subsFrom} where ${subsWhere}`,
              shown: SUBSCRIBED_SHOWN,
            }) as never,
          )
        : db.all(none),
      // Readers to follow, on the first page only, from what is public: people who recommended
      // posts from blogs the member reads, people whose shown subscriptions overlap theirs, and
      // people recommending lately (ADR 0031).
      first
        ? db.all(sql`
            select p.user_id as id, p.handle, p.display_name as "displayName", p.bio,
              ${avatarOf('p')} as avatar, count(*) as score
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

    type Person = ReturnType<typeof personOf>
    type Item =
      | {
          kind: 'recommended'
          key: string
          at: number
          person: Person
          note: string | null
          post: ReturnType<typeof postOf>
        }
      | {
          kind: 'liked'
          key: string
          at: number
          person: Person
          count: number
          posts: ReturnType<typeof postOf>[]
        }
      | { kind: 'subscribed'; key: string; at: number; person: Person; count: number; sites: Row[] }

    const items: Item[] = (recommended ?? []).map((r) => ({
      kind: 'recommended' as const,
      key: String(r.k),
      at: Number(r.at),
      person: personOf(r),
      note: (r.note as string | null) ?? null,
      post: postOf(r),
    }))
    /** A source's rows as their groups, in the order the query returned them. */
    const groups = (rows: Row[]) => {
      const byKey = new Map<string, Row[]>()
      for (const r of rows) byKey.set(String(r.k), [...(byKey.get(String(r.k)) ?? []), r])
      return [...byKey.values()]
    }
    for (const g of groups(liked ?? [])) {
      const head = g[0] as Row
      items.push({
        kind: 'liked',
        key: String(head.k),
        at: Number(head.groupAt),
        person: personOf(head),
        count: Number(head.total),
        posts: g.map(postOf),
      })
    }
    for (const g of groups(subscribed ?? [])) {
      const head = g[0] as Row
      items.push({
        kind: 'subscribed',
        key: String(head.k),
        at: Number(head.groupAt),
        person: personOf(head),
        count: Number(head.total),
        sites: g.map(
          ({
            userId: _u,
            handle: _h,
            displayName: _d,
            at,
            k: _k,
            groupAt: _g,
            rank: _r,
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

    // Each source gave its first `over` entries after the cursor, so the first `over` of them all
    // are among these; one past the page says there is more.
    items.sort(newestFirst)
    const page = items.slice(0, PAGE_ENTRIES)
    const last = page.at(-1)
    const next = items.length > PAGE_ENTRIES && last ? `${last.at}:${minutes}:${last.key}` : null

    return c.json(
      {
        items: page,
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
      select distinct p.user_id as id, p.handle, p.display_name as "displayName",
        ${avatarOf('p')} as avatar
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
