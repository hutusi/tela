/**
 * v1 sync (ADR 0065): the web's pull and push (ADR 0025) in the API's own format.
 *
 * `GET /v1/sync?lang=&types=&cursor=` answers through `answerPull`, with the title and body
 * translation rows of blogs whose writers said no left out on the server (`shownOnly`), titles in
 * the asked language only, and each row through its mapper in `@tela/ext/transform`, field by
 * field. The cursor is opaque: the seq, the language and the row types it holds whole; changing
 * the language, or asking for a type it does not hold, starts over with a snapshot (`reset`).
 *
 * `POST /v1/mutations` maps each of the 17 kinds to the web's mutation and applies them in one
 * push (`applyPush`, never exempt). Every `mid` is prefixed with the app's id, so two apps that
 * mint the same id cannot cancel each other's changes as replays. A subscribe past the member's
 * cap is answered `rejected` with `subscription_limit`, where the web's is a silent no-op.
 */
import { first, subscriptionRoom, type TelaDb } from '@tela/data'
import {
  mutationSchema,
  prefSchemas,
  pushRequestSchema,
  syncQuerySchema,
  type V1Mutation,
} from '@tela/ext/schema'
import {
  askedTypes,
  cursorNeedsReset,
  decodeCursor,
  encodeCursor,
  isV1PrefKey,
  type V1RowType,
  v1Article,
  v1Feed,
  v1FeedFolder,
  v1Folder,
  v1Follow,
  v1Highlight,
  v1Pref,
  v1Profile,
  v1Recommendation,
  v1Rejection,
  v1Site,
  v1State,
  v1Subscription,
  v1Title,
  v1Translation,
} from '@tela/ext/transform'
import type { Mutation, SyncRows } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiDeps } from '../../deps'
import { answerPull } from '../../sync/pull'
import { applyPush } from '../../sync/push'
import { type GatewayEnv, requireScope } from '../auth'
import { PRIVATE, refuse, v1Context } from './answer'

/** The app's prefix for a mutation id: `a<appId>:`, so the stored id stays within 64 characters. */
export const midPrefix = (appId: number) => `a${appId}:`

/** The web's mutation for a v1 one, its id prefixed with the app's. */
function internal(m: V1Mutation, prefix: string): Mutation {
  const mid = `${prefix}${m.mid}`
  switch (m.type) {
    case 'setReadingLanguage':
      return { type: 'setProfile', mid, at: m.at, readingLang: m.language }
    case 'setPref':
      return { type: 'setPref', mid, at: m.at, key: m.key, value: m.value as never }
    default:
      return { ...m, mid } as Mutation
  }
}

/**
 * Which subscribes in a push would go past the member's cap, decided as the push will be applied:
 * in order, a place taken by each subscribe to a feed not followed yet and freed by each
 * unsubscribe of one followed, a replay changing nothing. The push's own statement holds the cap
 * too (`subscriptionRoom`); this only lets an app hear it.
 */
async function overTheCap(db: TelaDb, userId: string, mutations: Mutation[]): Promise<Set<string>> {
  const moves = mutations.filter(
    (m): m is Extract<Mutation, { type: 'subscribe' | 'unsubscribe' }> =>
      m.type === 'subscribe' || m.type === 'unsubscribe',
  )
  const over = new Set<string>()
  if (moves.length === 0) return over
  const feedIds = [...new Set(moves.map((m) => m.feedId))]
  const mids = moves.map((m) => m.mid)
  const row = await first<{ room: number; targets: string; followed: string; replays: string }>(
    db,
    sql`select ${subscriptionRoom(userId, false)} as room,
      (select json_group_object(f.id, coalesce(f.merged_into, f.id)) from feeds f
        where f.id in (select value from json_each(${JSON.stringify(feedIds)}))) as targets,
      (select json_group_array(s.feed_id) from subscriptions s
        where s.user_id = ${userId} and s.deleted_at is null) as followed,
      (select json_group_array(m.mid) from applied_mutations m
        where m.user_id = ${userId}
          and m.mid in (select value from json_each(${JSON.stringify(mids)}))) as replays`,
  )
  let room = Number(row?.room ?? 0)
  const targets = JSON.parse(row?.targets ?? '{}') as Record<string, number>
  const followed = new Set(JSON.parse(row?.followed ?? '[]') as number[])
  const replays = new Set(JSON.parse(row?.replays ?? '[]') as string[])
  const done = new Set<string>()
  for (const m of moves) {
    if (replays.has(m.mid) || done.has(m.mid)) continue
    done.add(m.mid)
    const target = targets[String(m.feedId)]
    if (target === undefined) continue
    if (m.type === 'unsubscribe') {
      if (followed.delete(target)) room += 1
    } else if (!followed.has(target)) {
      if (room <= 0) over.add(m.mid)
      else {
        room -= 1
        followed.add(target)
      }
    }
  }
  return over
}

/** A stored pref row as v1 sends it, or null for a key or value it does not speak. */
function sentPref(row: SyncRows['prefs'][number]) {
  if (!isV1PrefKey(row.key)) return null
  return prefSchemas[row.key].safeParse(row.value).success ? v1Pref(row) : null
}

export function syncRoutes(deps: ApiDeps) {
  const routes = new Hono<GatewayEnv>()
  const ctx = v1Context(deps.config)

  routes.get('/sync', async (c) => {
    const query = syncQuerySchema.safeParse(c.req.query())
    if (!query.success) return refuse(c, 400, 'invalid_request')
    const { lang } = query.data
    const types = askedTypes(query.data.types)
    if (!types) return refuse(c, 400, 'invalid_request')
    const cursor = query.data.cursor ? decodeCursor(query.data.cursor) : null
    const startOver = cursorNeedsReset(cursor, lang, types)
    const now = deps.clock.now()
    const pull = await answerPull(
      deps.db,
      c.get('app').userId,
      startOver || !cursor ? 0 : cursor.seq,
      now,
      lang,
      { shownOnly: true },
    )
    const has = (type: V1RowType) => types.includes(type)
    const some = <T, U>(type: V1RowType, rows: T[], map: (row: T) => U | null): U[] =>
      has(type) ? rows.flatMap((r) => map(r) ?? []) : []
    const r = pull.rows
    const profile = r.profile[0]
    return c.json(
      {
        cursor: encodeCursor({ seq: pull.cursor, lang, types }),
        more: pull.more,
        reset: startOver || pull.reset,
        lang,
        types,
        rows: {
          profile: has('profile') && profile ? v1Profile(profile, ctx) : null,
          prefs: some('prefs', r.prefs, sentPref),
          subscriptions: some('subscriptions', r.subscriptions, v1Subscription),
          feeds: some('feeds', r.feeds, v1Feed),
          sites: some('sites', r.sites, (s) => v1Site(s, ctx)),
          articles: some('articles', r.articles, v1Article),
          titles: some('titles', r.titles, (t) => (t.lang === lang ? v1Title(t) : null)),
          states: some('states', r.states, v1State),
          recommendations: some('recommendations', r.recommendations, v1Recommendation),
          highlights: some('highlights', r.highlights, v1Highlight),
          translations: some('translations', r.translations, (t) =>
            t.lang === lang ? v1Translation(t, now) : null,
          ),
          folders: some('folders', r.folders, v1Folder),
          feedFolders: some('feedFolders', r.feedFolders, v1FeedFolder),
          follows: some('follows', r.follows, (f) => v1Follow(f, ctx)),
        },
      },
      200,
      PRIVATE,
    )
  })

  routes.post('/mutations', requireScope('write'), async (c) => {
    const body = pushRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return refuse(c, 400, 'invalid_request')
    const app = c.get('app')
    const prefix = midPrefix(app.appId)
    /** Per mutation sent, in order: refused here, or the web's mutation it became. */
    const outcomes = body.data.mutations.map((item) => {
      const mid =
        typeof (item as { mid?: unknown })?.mid === 'string' ? (item as { mid: string }).mid : null
      const parsed = mutationSchema.safeParse(item)
      if (!parsed.success) return { mid, error: 'invalid' as const }
      const m = parsed.data
      if (m.type === 'setPref' && !prefSchemas[m.key].safeParse(m.value).success) {
        return { mid, error: 'invalid' as const }
      }
      return { mid, mutation: internal(m, prefix) }
    })
    const mutations = outcomes.flatMap((o) => ('mutation' in o ? [o.mutation] : []))
    const over = await overTheCap(deps.db, app.userId, mutations)
    const sent = mutations.filter((m) => !over.has(m.mid))
    const result = await applyPush(deps.db, app.userId, sent, deps.clock.now(), { exempt: false })
    const applied = new Set(result.applied)
    const rejected = new Map(result.rejected.map((r) => [r.mid, r.error]))
    return c.json(
      {
        results: outcomes.map((o) => {
          if (!('mutation' in o)) return { mid: o.mid, status: 'rejected', error: o.error }
          const id = o.mutation.mid
          if (over.has(id)) return { mid: o.mid, status: 'rejected', error: 'subscription_limit' }
          if (applied.has(id)) return { mid: o.mid, status: 'applied' }
          return { mid: o.mid, status: 'rejected', error: v1Rejection(rejected.get(id) ?? '') }
        }),
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  return routes
}
