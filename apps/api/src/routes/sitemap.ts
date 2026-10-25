/**
 * What the sitemap lists (ADR 0060), as data: tela-web writes the XML (`/sitemap.xml` and the
 * files it names) from these answers, and adds Tela's own pages, which need no database.
 *
 * Only pages search engines may index, by the same predicates the pages themselves read
 * (`public-sql.ts`): blogs an operator listed, blogrolls Discover shows, profiles a week old and
 * in good standing. Each with when it last changed, as far as the page shows it.
 *
 * `GET /` says how many there are of each kind, the latest change of each, and how many go in one
 * file; `GET /<kind>?page=<n>` lists one file's worth, in a fixed order. Pages are counted by
 * offset: a page written meanwhile moves the rest one place on, which a sitemap read an hour later
 * puts right, so it is not worth a cursor the index could not name. Cached an hour at the edge,
 * as search engines read sitemaps no more often than that.
 */
import { BLOGROLL_ID } from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'
import {
  BLOGROLL_INDEXABLE,
  BLOGROLL_UPDATED_AT,
  profileIndexable,
  publicNotFound,
  SITE_INDEXABLE,
} from './public-sql'

/**
 * Pages in one sitemap file. Each is five `<url>`s there, one per language and the bare address,
 * each naming all five: 10,000 entries of about 700 bytes, well inside a file's 50,000 and 50 MB.
 */
export const SITEMAP_PAGE = 2000
export const SITEMAP_CACHE = 'public, max-age=3600, s-maxage=3600'
const MAX_PAGE = 1000

export const SITEMAP_KINDS = ['sites', 'blogrolls', 'profiles'] as const
export type SitemapKind = (typeof SITEMAP_KINDS)[number]

/** One kind's pages: the table they come from, when each last changed, and the order kept. */
const KINDS: Record<SitemapKind, (now: number) => { from: SQL; key: SQL; lastmod: SQL }> = {
  // A blog's page shows its newest posts, so it changes when its feeds bring one.
  sites: () => ({
    from: sql`sites s where ${SITE_INDEXABLE}`,
    key: sql`s.id`,
    lastmod: sql`max(s.updated_at, coalesce((select max(f.last_item_at) from feeds f
      where f.site_id = s.id and f.merged_into is null), 0))`,
  }),
  blogrolls: () => ({
    from: sql`blogrolls r join profiles p on p.user_id = r.user_id where ${BLOGROLL_INDEXABLE}`,
    key: sql`r.id`,
    lastmod: BLOGROLL_UPDATED_AT,
  }),
  // A profile shows its member's recommendations, newest first.
  profiles: (now) => ({
    from: sql`profiles p where ${profileIndexable(now)}`,
    key: sql`p.handle`,
    lastmod: sql`max(p.updated_at, coalesce((select max(r.created_at) from recommendations r
      where r.user_id = p.user_id and r.deleted_at is null), 0))`,
  }),
}

const isKind = (value: string): value is SitemapKind =>
  (SITEMAP_KINDS as readonly string[]).includes(value)

export function sitemapRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()
  const cached = { 'cache-control': SITEMAP_CACHE }

  routes.get('/', async (c) => {
    const now = deps.clock.now()
    const rows = (await db.batch(
      SITEMAP_KINDS.map((kind) => {
        const { from, lastmod } = KINDS[kind](now)
        return db.all(sql`select count(*) as count, max(${lastmod}) as lastmod from ${from}`)
      }) as never,
    )) as unknown as { count: number; lastmod: number | null }[][]
    const summary = Object.fromEntries(
      SITEMAP_KINDS.map((kind, i) => {
        const row = rows[i]?.[0]
        const lastmod = Number(row?.lastmod ?? 0)
        return [kind, { count: Number(row?.count ?? 0), lastmod: lastmod > 0 ? lastmod : null }]
      }),
    )
    return c.json({ pageSize: SITEMAP_PAGE, ...summary }, 200, cached)
  })

  routes.get('/:kind', async (c) => {
    const kind = c.req.param('kind')
    if (!isKind(kind)) return publicNotFound()
    const asked = Number(c.req.query('page') ?? '1')
    if (!Number.isInteger(asked) || asked < 1 || asked > MAX_PAGE) return publicNotFound()
    const { from, key, lastmod } = KINDS[kind](deps.clock.now())
    const rows = (await db.all(sql`
      select ${key} as key, ${lastmod} as lastmod from ${from}
      order by ${key} limit ${SITEMAP_PAGE} offset ${(asked - 1) * SITEMAP_PAGE}
    `)) as { key: string | number; lastmod: number | null }[]
    const items = rows
      // Only what the page's own address takes: a blogroll's id as its device minted it.
      .filter((r) => kind !== 'blogrolls' || BLOGROLL_ID.test(String(r.key)))
      .map((r) => ({
        [kind === 'profiles' ? 'handle' : 'id']: kind === 'sites' ? Number(r.key) : String(r.key),
        lastmod: Number(r.lastmod ?? 0) > 0 ? Number(r.lastmod) : null,
      }))
    return c.json({ kind, page: asked, items }, 200, cached)
  })

  return routes
}
