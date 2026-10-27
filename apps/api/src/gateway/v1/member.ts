/**
 * The v1 routes about the member a token acts for (ADR 0065): who they are, their day's limits,
 * asking for a translation, and adding feeds. Each is a shared rule (`core/*`) worded in the API's
 * own format, with the actor never exempt (ADR 0064): an app spends the member's day like the web
 * does, an admin's included.
 */
import { MAX_OPML_BYTES } from '@tela/content/opml'
import { avatarOf, type BodyTranslationRow, first } from '@tela/data'
import {
  addFeedRequestSchema,
  discoverFeedsRequestSchema,
  translationRequestSchema,
} from '@tela/ext/schema'
import { absoluteUrl, readingLanguage, v1Feed, v1Site, v1Translation } from '@tela/ext/transform'
import { APP_DEFAULT_PER_APP_PER_MIN, APP_DEFAULT_PER_MEMBER_PER_MIN } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { addFeedFor, discoverFeeds, importFeeds, knownFeeds, readFeed } from '../../core/feeds'
import { requestBodyTranslation, translationStatus } from '../../core/translations'
import { readUsage } from '../../core/usage'
import type { ApiDeps } from '../../deps'
import { readAtMost } from '../../read-at-most'
import { type GatewayEnv, invalidToken, requireScope } from '../auth'
import { actorOf, PRIVATE, refuse, secondsUntil, tooMany, v1Context } from './answer'

const CONTENT_KEY = /^[0-9a-f]{32}$/

/** What an ingest refusal is, as an HTTP status: a URL that is none, or a feed Tela cannot take. */
const INGEST_STATUS = {
  invalid_url: 400,
  unreachable: 422,
  not_a_feed: 422,
  feed_too_large: 422,
} as const

export function memberRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<GatewayEnv>()
  const ctx = v1Context(deps.config)
  /** A translation row as v1 sends it; a row in no reading language is none. */
  const row = (r: BodyTranslationRow | null) => (r ? v1Translation(r, deps.clock.now()) : null)

  routes.get('/me', async (c) => {
    const app = c.get('app')
    const profile = await first<{
      handle: string
      display_name: string | null
      avatar: string | null
      reading_lang: string | null
      email: string
    }>(
      db,
      sql`select p.handle, p.display_name, ${avatarOf('p')} as avatar, p.reading_lang, u.email
        from profiles p join user u on u.id = p.user_id where p.user_id = ${app.userId}`,
    )
    if (!profile) return invalidToken(c, true)
    return c.json(
      {
        handle: profile.handle,
        displayName: profile.display_name,
        avatar: absoluteUrl(ctx.publicUrl, profile.avatar),
        readingLanguage: readingLanguage(profile.reading_lang),
        scope: app.scope,
        // Only when the member let this app see it, and the operator lets the app ask.
        ...(app.email ? { email: profile.email } : {}),
      },
      200,
      PRIVATE,
    )
  })

  routes.get('/usage', async (c) => {
    const app = c.get('app')
    const [usage, limits] = await Promise.all([
      readUsage(deps, actorOf(c)),
      first<{ per_member_per_min: number | null; per_app_per_min: number | null }>(
        db,
        sql`select per_member_per_min, per_app_per_min from apps where id = ${app.appId}`,
      ),
    ])
    return c.json(
      {
        translations: usage.translations,
        feeds: usage.feeds,
        subscriptions: usage.subscriptions,
        posts: usage.posts,
        rateLimits: {
          perMemberPerMinute: limits?.per_member_per_min ?? APP_DEFAULT_PER_MEMBER_PER_MIN,
          perAppPerMinute: limits?.per_app_per_min ?? APP_DEFAULT_PER_APP_PER_MIN,
        },
      },
      200,
      PRIVATE,
    )
  })

  /**
   * Asking for a body translation spends the member's day, so it needs `write`. The core's
   * answers in v1's own set: `ready`, `running` (asked now, or someone's runs), `waiting` (put off
   * to `dueAt`, ADR 0057), `refused` (no room today or tomorrow), `unavailable` (the writer said
   * no, there is no body, or it is written in that language).
   */
  routes.post('/translations', requireScope('write'), async (c) => {
    const input = translationRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return refuse(c, 400, 'invalid_request')
    const answer = await requestBodyTranslation(deps, actorOf(c), input.data)
    const said = (status: string, translation: BodyTranslationRow | null, extra = {}) =>
      c.json({ status, translation: row(translation), ...extra }, 200, PRIVATE)
    switch (answer.status) {
      case 'bad_request':
        return refuse(c, 400, 'invalid_request')
      case 'not_found':
        return refuse(c, 404, 'not_found')
      case 'unavailable':
      case 'invalid':
        return said('unavailable', null)
      case 'ready':
        return said('ready', answer.translation)
      case 'requested':
      case 'in_progress':
        return said('running', answer.translation)
      case 'scheduled':
        return said('waiting', answer.translation)
      case 'rate_limited':
        return tooMany(c, 'rate_limited', answer.retryAfterSec)
      case 'budget_exhausted':
        return said('refused', answer.translation, {
          reason: answer.reason,
          resetsAt: answer.resetsAt,
        })
    }
  })

  /**
   * What exists of a body translation now. A writer's "no translation" is held here, not left to
   * the app: a translation of theirs is answered as none.
   */
  routes.get('/translations/:contentKey/:lang', async (c) => {
    const key = c.req.param('contentKey')
    const lang = readingLanguage(c.req.param('lang'))
    if (!CONTENT_KEY.test(key) || lang === null) return refuse(c, 400, 'invalid_request')
    const { translation, optedOut } = await translationStatus(deps, key, lang)
    return c.json({ translation: optedOut ? null : row(translation) }, 200, PRIVATE)
  })

  routes.post('/feeds/discover', requireScope('write'), async (c) => {
    const input = discoverFeedsRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return refuse(c, 400, 'invalid_request')
    const found = await discoverFeeds(deps, actorOf(c), input.data.url)
    if ('error' in found) {
      if (found.error === 'rate_limited') return tooMany(c, 'rate_limited', found.retryAfterSec)
      return refuse(c, INGEST_STATUS[found.error], found.error)
    }
    const known = await knownFeeds(
      db,
      found.feeds.map((f) => f.url),
    )
    return c.json(
      {
        feeds: found.feeds.map((f) => ({
          feedUrl: f.url,
          title: f.title,
          feedId: known.get(f.url) ?? null,
        })),
      },
      200,
      PRIVATE,
    )
  })

  routes.post('/feeds', requireScope('write'), async (c) => {
    const input = addFeedRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return refuse(c, 400, 'invalid_request')
    const actor = actorOf(c)
    const added = await addFeedFor(deps, actor, { feedUrl: input.data.url })
    if ('error' in added) {
      switch (added.error) {
        case 'rate_limited':
          return tooMany(c, 'rate_limited', added.retryAfterSec)
        case 'feed_limit':
          return tooMany(c, 'feed_limit', secondsUntil(added.resetsAt, deps.clock.now()), {
            limit: added.limit ?? 0,
            resetsAt: added.resetsAt,
          })
        case 'subscription_limit':
          return refuse(c, 409, 'subscription_limit', { limit: added.limit ?? 0 })
        default:
          return refuse(c, INGEST_STATUS[added.error], added.error)
      }
    }
    const held = await readFeed(deps, actor, added.feedId)
    if (!held) return refuse(c, 404, 'not_found')
    return c.json(
      { feed: v1Feed(held.feed), site: v1Site(held.site, ctx), added: added.created },
      200,
      PRIVATE,
    )
  })

  /** The OPML document itself is the body, read no further than its cap. */
  routes.post('/feeds/opml', requireScope('write'), async (c) => {
    if (Number(c.req.header('content-length') ?? '0') > MAX_OPML_BYTES) {
      return refuse(c, 413, 'too_large')
    }
    let bytes: Uint8Array<ArrayBuffer> | null
    try {
      bytes = await readAtMost(c.req.raw.body, MAX_OPML_BYTES)
    } catch {
      return refuse(c, 400, 'invalid_request')
    }
    if (!bytes) return refuse(c, 413, 'too_large')
    const result = await importFeeds(deps, actorOf(c), new TextDecoder().decode(bytes))
    if ('error' in result) {
      if (result.error === 'rate_limited') return tooMany(c, 'rate_limited', result.retryAfterSec)
      return refuse(c, 400, 'opml_invalid')
    }
    return c.json(
      {
        subscribed: result.subscribed,
        added: result.added,
        waiting: result.waiting,
        over: result.over,
        perDay: result.perDay,
        maxSubscriptions: result.maxSubscriptions,
        resetsAt: result.resetsAt,
      },
      200,
      PRIVATE,
    )
  })

  return routes
}
