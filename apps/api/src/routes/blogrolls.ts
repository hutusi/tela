/**
 * A public blogroll's page (ADR 0050): `/api/v1/public/blogrolls/:id`, what `/l/<id>` renders for
 * anyone who is not its owner. Its owner reads their own from the device, private ones too.
 *
 * What it shows, and to whom, is `readBlogroll`'s (`core/public.ts`), which the API shares (ADR
 * 0065): not found, alike, for an id of the wrong shape, one nobody made, a deleted blogroll and a
 * private one. Cached as a profile is, so a blogroll made private leaves within minutes (ADR 0031).
 */
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import { readBlogroll } from '../core/public'
import type { ApiDeps } from '../deps'
import { PROFILE_CACHE, publicNotFound } from './public-sql'

export { BLOG_DESCRIPTION_MAX } from '../core/public'

export function blogrollRoutes(deps: ApiDeps) {
  const routes = new Hono<ApiEnv>()

  routes.get('/:id', async (c) => {
    const page = await readBlogroll(deps, c.req.param('id'))
    if (!page) return publicNotFound()
    return c.json(page, 200, { 'cache-control': PROFILE_CACHE })
  })

  return routes
}
