/**
 * The sync protocol's promise (ADR 0025), tested against the real tela-api: whatever order a
 * device makes changes, pushes them (losing some responses), pulls, and meets articles the server
 * writes meanwhile, once it has pushed and pulled everything its tables equal a fresh snapshot,
 * and nothing is left pending.
 *
 * Seeded, so a failure names the seed that reproduces it.
 */
import { describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq } from '@tela/data'
import {
  applyPull,
  type Confirmed,
  emptyTables,
  type Mutation,
  type Pending,
  type PullResponse,
  type PushResponse,
  settle,
  type Tables,
  view,
} from '@tela/sync'
import { sql } from 'drizzle-orm'
import { createTestApi, signedIn, type TestApi } from './helpers'

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FEEDS = [1, 2, 3]
/** Members the device can follow (ADR 0031); they have profiles and never sign in. */
const PEOPLE = ['person-one-0000001', 'person-two-0000002', 'person-three-00003']

/** What a snapshot and a synced device must agree on, independent of how they got there. */
function live(t: Tables) {
  const subs = [...t.subscriptions.values()].filter((s) => s.deletedAt === null)
  const articles = [...t.articles.values()].sort((a, b) => a.id - b.id)
  const ids = new Set(articles.map((a) => a.id))
  return {
    subscriptions: subs
      .map((s) => ({ feedId: s.feedId, watermarkId: s.watermarkId }))
      .sort((a, b) => a.feedId - b.feedId),
    articles: articles.map((a) => ({
      id: a.id,
      likeCount: a.likeCount,
      recommendCount: a.recommendCount,
    })),
    states: [...t.states.values()]
      .filter((s) => ids.has(s.articleId) && (s.readAt !== null || s.likedAt !== null))
      .map((s) => ({ articleId: s.articleId, read: s.readAt !== null, liked: s.likedAt !== null }))
      .sort((a, b) => a.articleId - b.articleId),
    recommendations: [...t.recommendations.values()]
      .filter((r) => r.deletedAt === null)
      .map((r) => ({ articleId: r.articleId, note: r.note }))
      .sort((a, b) => a.articleId - b.articleId),
    highlights: [...t.highlights.values()]
      .map((h) => ({ id: h.id, articleId: h.articleId, leafId: h.leafId, note: h.note }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    prefs: [...t.prefs.values()]
      .map((p) => ({ key: p.key, value: p.value }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    follows: [...t.follows.values()]
      .map((f) => ({ userId: f.userId, handle: f.handle, displayName: f.displayName }))
      .sort((a, b) => a.userId.localeCompare(b.userId)),
    flags: {
      publicSubscriptions: t.profile?.publicSubscriptions,
      publicLikes: t.profile?.publicLikes,
      gravatar: t.profile?.gravatar,
    },
  }
}

async function scenario(seed: number, steps: number) {
  const random = rng(seed)
  const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(random() * xs.length)]
  const api: TestApi = await createTestApi()
  const member = await signedIn(api)
  let nextArticle = 1
  const write = (...s: ReturnType<typeof api.db.run>[]) =>
    api.db.batch([bumpSeq(api.db), ...s] as never)
  const addArticle = (feedId: number) => {
    const id = nextArticle++
    return write(
      api.db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, seq)
        values (${id}, ${feedId}, ${`k${id}`}, ${`Post ${id}`}, ${api.clock.now()}, ${api.clock.now()}, ${currentSeq})`),
    )
  }
  for (const f of FEEDS) {
    await write(
      api.db.run(sql`insert into sites (id, home_url, created_at, updated_at, seq)
        values (${f}, ${`https://b${f}.example`}, 0, 0, ${currentSeq})`),
      api.db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
        values (${f}, ${f}, ${`https://b${f}.example/feed`}, ${`b${f}.example`}, 0, 0, 0, ${currentSeq})`),
    )
    await addArticle(f)
    await addArticle(f)
  }
  for (const [i, id] of PEOPLE.entries()) {
    await write(
      api.db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
        values (${id}, 'p', ${`p${i}@x.test`}, 1, 0, 0)`),
      api.db.run(sql`insert into profiles (user_id, handle, created_at, updated_at, seq)
        values (${id}, ${`person_${i}`}, 0, 0, ${currentSeq})`),
    )
  }
  /** Someone the device may follow changes their name, which the follow row carries. */
  let renames = 0
  const rename = (id: string) =>
    write(
      api.db.run(sql`update profiles set display_name = ${`Name ${++renames}`}, seq = ${currentSeq}
        where user_id = ${id}`),
    )

  let confirmed: Confirmed = { cursor: 0, tables: emptyTables() }
  let pending: Pending[] = []
  let mids = 0

  const pull = async () => {
    for (;;) {
      const res = await api.request(`/api/v1/sync?cursor=${confirmed.cursor}`, { as: member })
      const body = (await res.json()) as PullResponse
      confirmed = applyPull(confirmed, body)
      pending = settle(confirmed, pending)
      if (!body.more) return
    }
  }
  const push = async (loseResponse: boolean) => {
    const batch = pending.filter((p) => p.ackedAt === undefined).slice(0, 50)
    if (batch.length === 0) return
    const res = await api.request('/api/v1/mutations', {
      body: { mutations: batch.map((p) => p.mutation) },
      as: member,
    })
    if (loseResponse) return // applied on the server; the device never hears, and sends again
    const body = (await res.json()) as PushResponse
    const applied = new Set(body.applied)
    const rejected = new Set(body.rejected.map((r) => r.mid))
    pending = pending
      .filter((p) => !rejected.has(p.mutation.mid))
      .map((p) => (applied.has(p.mutation.mid) ? { ...p, ackedAt: body.seq } : p))
  }
  const mutate = () => {
    const shown = view(confirmed, pending)
    const articleIds = [...shown.articles.keys()]
    const at = api.clock.now()
    api.clock.advance(1 + Math.floor(random() * 5))
    const mid = `seed${seed}-m${++mids}-pad`
    const choice = Math.floor(random() * 16)
    const article = pick(articleIds)
    const feed = pick(FEEDS) as number
    let m: Mutation | null = null
    if (choice === 0 && article) m = { mid, at, type: 'markRead', articleId: article }
    if (choice === 1 && article)
      m = { mid, at, type: 'setLiked', articleId: article, liked: random() < 0.6 }
    if (choice === 2 && articleIds.length > 0) {
      const upTo = pick(articleIds) as number
      m =
        random() < 0.5
          ? { mid, at, type: 'markAllRead', upTo }
          : { mid, at, type: 'markAllRead', feedId: feed, upTo }
    }
    if (choice === 3 || choice === 4) m = { mid, at, type: 'subscribe', feedId: feed }
    if (choice === 5) m = { mid, at, type: 'unsubscribe', feedId: feed }
    if (choice === 6)
      m = {
        mid,
        at,
        type: 'setPref',
        key: 'reader.mode',
        value: pick(['side', 'orig', 'trans']) as string,
      }
    if (choice === 7 && article)
      m = { mid, at, type: 'recommend', articleId: article, note: random() < 0.5 ? 'nice' : null }
    if (choice === 8 && article) m = { mid, at, type: 'unrecommend', articleId: article }
    // Highlights: a new one, an edit of one held (a note, or a re-anchor), or a deletion.
    const held = pick([...shown.highlights.keys()])
    const put = (id: string, articleId: number): Mutation => ({
      mid,
      at,
      type: 'putHighlight',
      id,
      articleId,
      contentKey: 'a'.repeat(32),
      side: 'original',
      lang: null,
      leafId: pick(['leaf000001', 'leaf000002']) as string,
      start: 0,
      end: 4,
      quote: 'Post',
      prefix: '',
      suffix: ' 1',
      note: random() < 0.5 ? `note ${mids}` : null,
    })
    if (choice === 9 && article) m = put(`seed${seed}-h${mids}`, article)
    if (choice === 10 && held) m = put(held, shown.highlights.get(held)?.articleId ?? 1)
    if (choice === 11 && held) m = { mid, at, type: 'deleteHighlight', id: held }
    const person = pick(PEOPLE) as string
    if (choice === 12) m = { mid, at, type: 'follow', userId: person }
    if (choice === 13) m = { mid, at, type: 'unfollow', userId: person }
    if (choice === 14)
      m =
        random() < 0.5
          ? { mid, at, type: 'setPrivacy', publicSubscriptions: random() < 0.5 }
          : { mid, at, type: 'setPrivacy', publicLikes: random() < 0.5 }
    if (choice === 15) m = { mid, at, type: 'setAvatar', gravatar: random() < 0.5 }
    if (m) pending.push({ mutation: m })
  }

  for (let i = 0; i < steps; i++) {
    const r = random()
    if (r < 0.45) mutate()
    else if (r < 0.65) await push(random() < 0.25)
    else if (r < 0.88) await pull()
    else if (r < 0.95) await addArticle(pick(FEEDS) as number)
    else await rename(pick(PEOPLE) as string)
  }

  // Quiescence: everything pushed, everything pulled.
  for (let i = 0; i < 10 && pending.length > 0; i++) {
    await push(false)
    await pull()
  }
  await pull()
  expect(pending).toEqual([])
  const snapshot = applyPull(
    { cursor: 0, tables: emptyTables() },
    (await (await api.request('/api/v1/sync?cursor=0', { as: member })).json()) as PullResponse,
  )
  expect(live(view(confirmed, pending))).toEqual(live(snapshot.tables))
}

describe('sync converges', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    test(`seed ${seed}: any interleaving of changes, pushes, lost responses and pulls`, async () => {
      await scenario(seed, 60)
    })
  }
})
