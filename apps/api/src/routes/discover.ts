/**
 * Discover's tabs past Blogs (ADR 0044): This week, Articles, Blogrolls (ADR 0050) and Readers.
 * Each answer is the same for everyone, so the edge renders it for visitors and caches it; what is
 * personal (hiding the blogs a member reads, naming the people they follow, grouping suggested
 * readers by what they like) is worked out on the device, from its own rows. Nothing about the
 * viewer reaches here.
 *
 * What each tab may show is `readDiscover`'s (`core/public.ts`), which the API shares (ADR 0065).
 * Each is cached as a profile is, minutes and never a day: the readers carry public subscriptions,
 * which a member can stop showing (ADR 0031), and a week's counts go stale.
 *
 * Mounted at `/api/v1/public/discover`, beside the Blogs answer at that path itself (`public.ts`).
 */
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import { readDiscover } from '../core/public'
import type { ApiDeps } from '../deps'
import { PROFILE_CACHE } from './public-sql'

export {
  ARTICLES_PAGE,
  BLOGROLLS_PAGE,
  DISCOVER_CARD_BLOGS,
  type DiscoverPost,
  EARLY_MIN,
  NEW_BLOGS,
  type Person,
  READERS_IN_WEEK,
  READERS_POOL,
  RECOMMENDERS_SHOWN,
  RECS_IN_WEEK,
  RECS_PER_READER,
  type ReaderCandidate,
  type ReaderPost,
  readersPool,
  WEEK_POSTS,
} from '../core/public'

export function discoverRoutes(deps: ApiDeps) {
  const routes = new Hono<ApiEnv>()
  const cached = { 'cache-control': PROFILE_CACHE }

  routes.get('/week', async (c) => c.json(await readDiscover(deps, 'week'), 200, cached))

  routes.get('/articles', async (c) =>
    c.json(
      await readDiscover(deps, 'articles', {
        topic: c.req.query('topic'),
        lang: c.req.query('lang'),
        cursor: c.req.query('cursor'),
      }),
      200,
      cached,
    ),
  )

  routes.get('/blogrolls', async (c) =>
    c.json(await readDiscover(deps, 'blogrolls', { cursor: c.req.query('cursor') }), 200, cached),
  )

  /** Readers: the people Discover may suggest, for the device to match to what its member likes. */
  routes.get('/readers', async (c) => c.json(await readDiscover(deps, 'readers'), 200, cached))

  return routes
}
