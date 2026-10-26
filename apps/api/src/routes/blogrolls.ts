/**
 * A public blogroll's page (ADR 0050): `/api/v1/public/blogrolls/:id`, what `/l/<id>` renders for
 * anyone who is not its owner. Its owner reads their own from the device, private ones too.
 *
 * Not found, alike, for an id of the wrong shape, one nobody made, a deleted blogroll and a
 * private one: a private blogroll's id is refused to anyone who guesses it and to anyone it was
 * shared with alike, and the answer never says which. The operator's Hide from Discover does not
 * touch the page.
 *
 * The blogs are the ones others see (`visibleBlogsFrom`: not taken out, not of a blog the operator
 * hid), in the order they were put in, each with its reader count from three readers up and its
 * blog's description cut to a tagline. Cached as a profile is, so a blogroll made private leaves
 * within minutes (ADR 0031).
 */
import { avatarOf, BLOG_NAME, isShown, standingOk, visibleBlogsFrom } from '@tela/data'
import { BLOGROLL_ID } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'
import {
  BLOGROLL_UPDATED_AT,
  blogrollIndexable,
  PROFILE_CACHE,
  PUBLIC_LISTING,
  publicNotFound,
  READER_COUNT,
} from './public-sql'

/** How much of a blog's own description a row shows: a tagline, not its About. */
export const BLOG_DESCRIPTION_MAX = 300

type Row = Record<string, unknown>

export function blogrollRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  routes.get('/:id', async (c) => {
    const id = c.req.param('id')
    if (!BLOGROLL_ID.test(id)) return publicNotFound()
    const [heads, blogs] = (await db.batch([
      // Its owner by their profile: a member with no profile has no public name to show it under.
      db.all(sql`
        select r.id, r.name, r.description, ${BLOGROLL_UPDATED_AT} as "updatedAt",
          ${blogrollIndexable(deps.clock.now())} as indexable, p.user_id as "ownerId", p.handle, p.display_name as "displayName",
          ${avatarOf('p')} as avatar
        from blogrolls r join profiles p on p.user_id = r.user_id
        where r.id = ${id} and ${isShown('r')} and ${standingOk('p')}
      `),
      // A merged feed's row stays (ADR 0028): it is not updating when the feed it became is not.
      db.all(sql`
        select bb.feed_id as "feedId", s.id as "siteId", ${BLOG_NAME} as name,
          s.home_url as "homeUrl", s.favicon_key as "faviconKey", s.primary_lang as "primaryLang",
          substr(s.description, 1, ${sql.raw(String(BLOG_DESCRIPTION_MAX))}) as description,
          (s.listing in ${PUBLIC_LISTING}) as listed, ${READER_COUNT} as "readerCount",
          (coalesce((select t.status from feeds t where t.id = f.merged_into), f.status) = 'dead')
            as dead,
          bb.note, bb.added_at as "addedAt"
        from blogrolls r, ${visibleBlogsFrom('r')}
          and r.id = ${id} and ${isShown('r')}
        order by bb.added_at, bb.feed_id
      `),
    ] as never)) as unknown as Row[][]
    const head = heads?.[0]
    if (!head) return publicNotFound()
    return c.json(
      {
        blogroll: {
          id: String(head.id),
          name: String(head.name),
          description: String(head.description ?? ''),
          updatedAt: Number(head.updatedAt),
          // Whether search engines may index it (ADR 0060).
          indexable: head.indexable === 1,
        },
        owner: {
          id: String(head.ownerId),
          handle: String(head.handle),
          displayName: (head.displayName as string | null) ?? null,
          avatar: (head.avatar as string | null) ?? null,
        },
        blogs: (blogs ?? []).map((b) => ({
          feedId: Number(b.feedId),
          siteId: Number(b.siteId),
          name: (b.name as string | null) ?? null,
          homeUrl: String(b.homeUrl),
          faviconKey: (b.faviconKey as string | null) ?? null,
          primaryLang: (b.primaryLang as string | null) ?? null,
          description: (b.description as string | null) || null,
          listed: b.listed === 1,
          readerCount: b.readerCount == null ? null : Number(b.readerCount),
          dead: b.dead === 1,
          note: (b.note as string | null) ?? null,
          addedAt: Number(b.addedAt),
        })),
      },
      200,
      { 'cache-control': PROFILE_CACHE },
    )
  })

  return routes
}
