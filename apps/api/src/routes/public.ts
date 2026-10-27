/**
 * What anyone may see, signed in or not: the front page's edition, Discover, a blog's page, a
 * member's public profile, and whether a handle is free. JSON here; tela-web renders it into
 * server-side pages and caches them at the edge (ADR 0024; the pages come with the SPA's
 * components in Phase 6).
 *
 * Only listed and featured blogs appear. The Postgres app rendered a private or rejected site's
 * page for anyone with its id, which on a cached public page would be a leak. A reader count is
 * given from three readers up and is null below, in the order as well as the value, and no answer
 * says how a blog was listed: nothing public renders it, and beside a held-back count it would
 * tell a blog an operator listed from the queue from an editorial pick (ADR 0041).
 */
import { consumeLimit, first, signupState } from '@tela/data'
import { HANDLE, RESERVED_HANDLES } from '@tela/shared'
import { getIP } from 'better-auth/api'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { Auth } from '../auth'
import { pageOf, readDiscover, readProfile, readSitePage } from '../core/public'
import type { ApiDeps } from '../deps'
import {
  DAY,
  editionStatement,
  PROFILE_CACHE,
  PUBLIC_CACHE,
  PUBLIC_LISTING,
  parseLangMap,
  publicNotFound,
  withTitles,
} from './public-sql'

/** Discover's page of blogs and a profile card's blogs are the shared reads' (`core/public.ts`). */
export { DISCOVER_PAGE, PROFILE_CARD_BLOGS } from '../core/public'
export { PROFILE_CACHE, PUBLIC_CACHE }

/** The front page's edition: the week's newest post from each blog, at most this many. */
export const EDITION_POSTS = 11
/** better-auth's bucket for a request whose IP it cannot tell, which all such requests share. */
const NO_IP = 'no-trusted-ip'
/** Suffixes tried, in order, for a free handle near one that is taken or reserved. */
const HANDLE_SUFFIXES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '_writes']

export function publicRoutes(deps: ApiDeps, auth: Auth) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()
  const cached = { 'cache-control': PUBLIC_CACHE }

  /**
   * What the sign-in sheet offers: each provider only once its app is configured (ADR 0036), and
   * whether joining needs an invite code (`signup: 'invite'`) or not (`'open'`), and if not,
   * whether today's new accounts have filled the day (`paused`, ADR 0056). A browser may keep the
   * answer a minute, so a switch the operator flips shows in the sheet within that; the gate reads
   * the switch itself whatever the sheet thought.
   */
  routes.get('/auth', async (c) => {
    const signup = await signupState(db, deps.clock.now())
    return c.json(
      {
        google: Boolean(deps.config.oauth?.google),
        github: Boolean(deps.config.oauth?.github),
        signup: signup.mode,
        paused: signup.paused,
      },
      200,
      { 'cache-control': 'public, max-age=60' },
    )
  })

  // Discover's Blogs, which `readDiscover` decides as the API's does (ADR 0065).
  routes.get('/discover', async (c) =>
    c.json(
      await readDiscover(deps, 'blogs', {
        topic: c.req.query('topic'),
        lang: c.req.query('lang'),
        page: pageOf(c.req.query('page')),
      }),
      200,
      cached,
    ),
  )

  routes.get('/sites/:siteId', async (c) => {
    const found = await readSitePage(deps, Number(c.req.param('siteId')))
    if (!found) return publicNotFound()
    const { more: _more, ...page } = found
    return c.json(page, 200, cached)
  })

  routes.get('/profiles/:handle', async (c) => {
    const found = await readProfile(deps, c.req.param('handle'))
    if (!found) return publicNotFound()
    const { more: _more, ...page } = found
    return c.json(page, 200, { 'cache-control': PROFILE_CACHE })
  })

  /**
   * The front page's edition (ADR 0035): the newest post of each public blog, newest first, from
   * the last seven days, or the latest ones when nobody wrote that week (`editionStatement`); and
   * the counts its copy states. Cached as a profile is, so the counts a visitor reads are minutes
   * old at most.
   */
  routes.get('/front', async (c) => {
    const now = deps.clock.now()
    const since = now - 7 * DAY
    const [rows, counts] = (await db.batch([
      db.all(editionStatement(now)),
      db.all(sql`
        select (select count(*) from sites where listing in ${PUBLIC_LISTING}) as blogs,
          count(distinct f.site_id) as "weekBlogs",
          count(distinct a.source_lang) as "weekLanguages",
          count(a.id) as "weekPosts"
        from sites s join feeds f on f.site_id = s.id and f.merged_into is null
        join articles a on a.feed_id = f.id and a.sort_at >= ${since} and a.sort_at <= ${now}
        where s.listing in ${PUBLIC_LISTING}
      `),
    ] as never)) as unknown as [Record<string, unknown>[], Record<string, unknown>[]]
    const week = rows.filter((r) => Number(r.sortAt) >= since)
    const span = week.length > 0 ? 'week' : 'latest'
    const count = counts[0] ?? {}
    return c.json(
      {
        counts: { blogs: Number(count.blogs ?? 0) },
        week: {
          blogs: Number(count.weekBlogs ?? 0),
          languages: Number(count.weekLanguages ?? 0),
          posts: Number(count.weekPosts ?? 0),
        },
        edition: {
          span,
          posts: (span === 'week' ? week : rows).slice(0, EDITION_POSTS).map((r) => {
            const {
              siteId,
              siteTitle,
              homeUrl,
              faviconKey,
              primaryLang,
              siteVouched,
              claimantHandle,
              claimantName,
              excerpts,
              ...article
            } = r
            return {
              article: { ...withTitles(article), excerpts: parseLangMap(excerpts) },
              site: {
                id: siteId,
                title: siteTitle,
                homeUrl,
                faviconKey,
                primaryLang,
                // An operator listed it: the post's link is followed (ADR 0060).
                vouched: siteVouched === 1,
              },
              claimant: claimantHandle
                ? { handle: claimantHandle, displayName: claimantName }
                : null,
            }
          }),
        },
      },
      200,
      { 'cache-control': PROFILE_CACHE },
    )
  })

  /**
   * Whether a handle is free, for For writers' card as it is typed: `invalid` (the shape
   * `HANDLE` refuses), `reserved` (an app path), `taken`, or `available`; and, unless it is
   * invalid, the first free handle among it and a few made from it. Never cached: the answer
   * changes the moment someone takes one. Counted per IP. The profile save it comes before checks
   * the same rules again, in the statement that takes the handle.
   */
  routes.get('/handles/:handle', async (c) => {
    const handle = c.req.param('handle').trim().toLowerCase()
    const noStore = { 'cache-control': 'no-store' }
    // A shape the rules refuse costs no query, so it spends none of the IP's checks.
    if (!HANDLE.test(handle)) {
      return c.json({ handle, status: 'invalid', suggestion: null }, 200, noStore)
    }
    const ip = getIP(c.req.raw, auth.options) ?? NO_IP
    const limited = await consumeLimit(db, 'handleCheck', ip, deps.clock.now())
    if (!limited.allowed) {
      return c.json({ error: 'rate_limited' }, 429, {
        ...noStore,
        'retry-after': String(limited.retryAfterSec),
      })
    }
    const reserved = RESERVED_HANDLES.has(handle)
    // Free ones only, in order: the handle itself first, so the first free one says whether it is.
    const candidates = [
      ...(reserved ? [] : [handle]),
      ...HANDLE_SUFFIXES.map((suffix) => `${handle}${suffix}`).filter(
        (h) => HANDLE.test(h) && !RESERVED_HANDLES.has(h),
      ),
    ]
    const free = await first<{ value: string }>(
      db,
      sql`select j.value from json_each(${JSON.stringify(candidates)}) j
        where not exists (select 1 from profiles p where p.handle = j.value)
        order by j.key limit 1`,
    )
    const suggestion = free?.value ?? null
    const status = reserved ? 'reserved' : suggestion === handle ? 'available' : 'taken'
    return c.json({ handle, status, suggestion }, 200, noStore)
  })

  return routes
}
