/**
 * How the web's public answers are cached and refused. Their SQL is `core/public-sql.ts`, shared
 * with the API (ADR 0065), and is re-exported here for the routes that read both.
 */
export * from '../core/public-sql'

/** Five minutes at the edge, a day of serving stale while it refreshes. */
export const PUBLIC_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400'
/**
 * A profile shows what its member chose to show, and Settings tells them a change reaches it in a
 * few minutes: a browser may serve its copy a minute and four more while it asks again, never a
 * day (ADR 0031). Discover's Blogs and a blog's page keep PUBLIC_CACHE (ADR 0024); its other
 * tabs carry recommendations and public subscriptions, so they are cached as a profile is.
 */
export const PROFILE_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=240'
/**
 * A public answer that has nothing to show: a minute in the browser and at the edge, so a page made
 * public (a blog listed, a blogroll shown) is found within minutes of a visit that missed it.
 */
export function publicNotFound(): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60, s-maxage=60',
    },
  })
}
