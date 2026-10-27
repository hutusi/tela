/**
 * A small, deterministic Tela for the v1 API's tests (ADR 0065): five public blogs, one of which
 * said no to translation, a handful of posts with titles and body translations, and two members,
 * Ann, whose app the tests drive, and Bo, who recommends, likes, subscribes in public and keeps a
 * blogroll. Every id, key and time is fixed, against the test clock, so the answers the v1 routes
 * give over it are the same on every run: the golden fixtures (`docs/api/v1/examples`) are made
 * from it.
 */
import { bumpSeq, currentSeq } from '@tela/data'
import { sql } from 'drizzle-orm'
import { connect, gateway, registerApp, type TestApp, type TokenAnswer } from './apps-helpers'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

/** A content key that reads as one: `c0ffee`, then the post's id. */
export const keyOf = (articleId: number) => `c0ffee${String(articleId).padStart(26, '0')}`

/** Bo's public blogroll. */
export const BLOGROLL = 'BoBlogroll01'

export type World = {
  api: TestApi
  now: number
  ann: SignedIn
  bo: SignedIn
  app: TestApp
  /** Ann's tokens for the app: read and write. */
  tokens: TokenAnswer
}

/** Write in one batch that bumps the sync sequence, as every writer of synced rows does. */
export async function write(api: TestApi, ...statements: unknown[]) {
  await api.db.batch([bumpSeq(api.db), ...statements] as never)
}

/** A post of the world: ids, feed, title and when, the rest following from them. */
export async function addPost(
  api: TestApi,
  post: {
    id: number
    feedId: number
    title: string
    at: number
    lang?: string
    excerpt?: string
  },
) {
  const { db } = api
  const key = keyOf(post.id)
  await write(
    api,
    db.run(sql`insert into articles (id, feed_id, dedup_key, url, title, author, published_at,
        fetched_at, sort_at, source_lang, excerpt, current_version, content_key, word_count,
        reading_minutes, title_hash, seq)
      values (${post.id}, ${post.feedId}, ${`k${post.id}`},
        ${`https://blog${post.feedId}.example/posts/${post.id}`}, ${post.title}, 'A. Writer',
        ${post.at}, ${post.at}, ${post.at}, ${post.lang ?? 'en'},
        ${post.excerpt ?? `The opening of “${post.title}”.`}, 1, ${key}, 1200, 6, ${`h${post.id}`},
        ${currentSeq})`),
    db.run(sql`insert into article_versions (article_id, version, provenance, content_key,
        norm_version, body_chars, created_at)
      values (${post.id}, 1, 'feed', ${key}, 1, 7200, ${post.at})`),
  )
}

/** A title translation of a post, made from the title it has now. */
export async function addTitle(
  api: TestApi,
  articleId: number,
  feedId: number,
  lang: string,
  title: string,
  excerpt: string | null = null,
) {
  const { db } = api
  await write(
    api,
    db.run(sql`insert into article_titles (article_id, lang, feed_id, title, excerpt, status,
        source_hash, updated_at, seq)
      values (${articleId}, ${lang}, ${feedId}, ${title}, ${excerpt}, 'done', ${`h${articleId}`},
        0, ${currentSeq})`),
  )
}

/** A body translation row of a post's content. */
export async function addTranslation(
  api: TestApi,
  articleId: number,
  lang: string,
  row: { state: string; objectKey?: string | null; chunkKeys?: string[]; dueAt?: number | null },
) {
  const { db } = api
  await write(
    api,
    db.run(sql`insert into body_translations (content_key, lang, state, chunk_keys, object_key,
        due_at, updated_at, seq)
      values (${keyOf(articleId)}, ${lang}, ${row.state}, ${JSON.stringify(row.chunkKeys ?? [])},
        ${row.objectKey ?? null}, ${row.dueAt ?? null}, 0, ${currentSeq})`),
  )
}

let mids = 0
/** A push through the web's route, as Bo's browser makes one. */
export async function webPush(api: TestApi, who: SignedIn, mutations: Record<string, unknown>[]) {
  const res = await api.request('/api/v1/mutations', {
    as: who,
    body: {
      mutations: mutations.map((m) => ({
        mid: `web-${++mids}-padding`,
        at: api.clock.now(),
        ...m,
      })),
    },
  })
  if (res.status !== 200) throw new Error(`web push failed: ${res.status}`)
  return res.json()
}

/** A call to the API as the app makes one, through tela-gateway, with Ann's token by default. */
export function call(
  world: Pick<World, 'api' | 'tokens'>,
  path: string,
  init: { method?: string; body?: unknown; raw?: string; token?: string } = {},
) {
  const body =
    init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body as object))
  return gateway(world.api, path, {
    ...(init.method ? { method: init.method } : {}),
    token: init.token ?? world.tokens.access_token,
    ...(body === undefined ? {} : { body }),
    headers:
      init.raw !== undefined
        ? { 'content-type': 'text/x-opml' }
        : body === undefined
          ? {}
          : { 'content-type': 'application/json' },
  })
}

/**
 * The world: the blogs, their posts and translations, Ann and Bo, Bo's public life, and Ann's app
 * connected with read and write. Ann has done nothing yet: each test drives her app from here.
 */
export async function buildWorld(): Promise<World> {
  const api = await createTestApi()
  const { db } = api
  const now = api.clock.now()
  const ann = await signedIn(api, 'ann@x.test')
  const bo = await signedIn(api, 'bo@x.test')
  await write(
    api,
    db.run(sql`update profiles set handle = 'ann', display_name = 'Ann Lee',
        reading_lang = 'zh-Hans', seq = ${currentSeq} where user_id = ${ann.userId}`),
    db.run(sql`update profiles set handle = 'bo_reads', display_name = 'Bo',
        bio = 'Reads about type and slow software.', public_likes = 1, public_subscriptions = 1,
        gravatar = 1, gravatar_found = 1, created_at = ${now - 60 * DAY}, seq = ${currentSeq}
        where user_id = ${bo.userId}`),
    db.run(sql`insert into sites (id, home_url, title, description, favicon_key, primary_lang,
        listing, review, translation_opt_out, created_at, updated_at, seq)
      values
        (1, 'https://blog1.example', 'Ink & Pixels', 'Notes on type and the screen.',
          'favicons/1.png', 'en', 'featured', 'listed', 0, ${now - 90 * DAY}, 0, ${currentSeq}),
        (2, 'https://blog2.example', 'Quiet Notes', 'A writer who asked not to be translated.',
          null, 'en', 'listed', 'listed', 1, ${now - 80 * DAY}, 0, ${currentSeq}),
        (3, 'https://blog3.example', '慢读', '读得慢一点。', null, 'zh-Hans', 'listed', 'listed',
          0, ${now - 70 * DAY}, 0, ${currentSeq}),
        (4, 'https://blog4.example', 'Field Log', 'Walks, maps and weather.', null, 'en',
          'listed', 'listed', 0, ${now - 60 * DAY}, 0, ${currentSeq}),
        (5, 'https://blog5.example', 'Nuit blanche', 'Carnets de nuit.', null, 'fr', 'listed',
          'listed', 0, ${now - 50 * DAY}, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, title, host, status, next_fetch_at,
        last_fetched_at, last_item_at, created_at, updated_at, seq)
      select value, value, 'https://blog' || value || '.example/feed.xml', null,
        'blog' || value || '.example', 'active', 0, ${now - HOUR}, ${now - 2 * HOUR}, 0, 0,
        ${currentSeq}
      from json_each('[1,2,3,4,5]') where true`),
    db.run(sql`insert into site_topics (site_id, topic)
      values (1, 'design'), (1, 'tech'), (3, 'culture'), (4, 'science')`),
  )
  await addPost(api, { id: 101, feedId: 1, title: 'Drawing with pixels', at: now - 2 * HOUR })
  await addPost(api, { id: 102, feedId: 1, title: 'A grid for every page', at: now - DAY })
  await addPost(api, { id: 201, feedId: 2, title: 'Silence, kept', at: now - 3 * HOUR })
  await addPost(api, {
    id: 301,
    feedId: 3,
    title: '一个人的书店',
    at: now - 5 * HOUR,
    lang: 'zh-Hans',
    excerpt: '城里最小的书店。',
  })
  await addPost(api, { id: 401, feedId: 4, title: 'Weather on the ridge', at: now - 2 * DAY })
  await addTitle(api, 101, 1, 'zh-Hans', '用像素作画', '关于像素的开头。')
  await addTitle(api, 101, 1, 'fr', 'Dessiner avec des pixels')
  await addTitle(api, 102, 1, 'zh-Hans', '每一页的网格')
  // The writer of blog 2 said no: what was translated before stays stored, and is never sent.
  await addTitle(api, 201, 2, 'zh-Hans', '被守住的安静')
  await addTitle(api, 301, 3, 'en', 'A bookshop of one')
  await addTitle(api, 401, 4, 'zh-Hans', '山脊上的天气')
  await addTranslation(api, 101, 'zh-Hans', {
    state: 'done',
    objectKey: `t/${keyOf(101)}/zh-Hans/5e1f2a.json`,
    chunkKeys: [`tc/${keyOf(101)}/zh-Hans/r1/0.json`],
  })
  await addTranslation(api, 102, 'zh-Hans', { state: 'requested', dueAt: now + 6 * HOUR })
  await addTranslation(api, 101, 'fr', { state: 'done', objectKey: `t/${keyOf(101)}/fr/9a8b.json` })
  await addTranslation(api, 201, 'zh-Hans', {
    state: 'done',
    objectKey: `t/${keyOf(201)}/zh-Hans/77aa.json`,
  })

  // Bo's public life: subscriptions shown, a recommendation with a note, a like, a blogroll.
  await webPush(api, bo, [
    { type: 'subscribe', feedId: 1 },
    { type: 'subscribe', feedId: 3 },
    { type: 'subscribe', feedId: 4 },
    { type: 'recommend', articleId: 101, note: 'The clearest thing on pixels I have read.' },
    { type: 'recommend', articleId: 401, note: null },
    { type: 'setLiked', articleId: 301, liked: true },
    {
      type: 'putBlogroll',
      id: BLOGROLL,
      name: 'Slow reading',
      description: 'Blogs worth the wait.',
      isPublic: true,
    },
    { type: 'rollBlog', blogrollId: BLOGROLL, feedId: 1 },
    { type: 'rollBlog', blogrollId: BLOGROLL, feedId: 3 },
    { type: 'rollBlog', blogrollId: BLOGROLL, feedId: 4 },
    { type: 'noteBlog', blogrollId: BLOGROLL, feedId: 3, note: 'Short and kind.' },
  ])

  const app = await registerApp(api)
  const tokens = await connect(api, ann, app)
  return { api, now, ann, bo, app, tokens }
}
