/**
 * The sync protocol's promise (ADR 0025), tested against the real tela-api: whatever order a
 * member's devices make changes, push them (losing some responses), pull, and meet articles the
 * server writes meanwhile, once each has pushed and pulled everything its tables equal a fresh
 * snapshot, and nothing is left pending. Two devices of one member take turns, the second with a
 * clock that runs a little behind, so a change made later can carry the older `at`.
 *
 * Seeded, so a failure names the seed that reproduces it.
 */
import { describe, expect, test } from 'bun:test'
import { bumpSeq, currentSeq } from '@tela/data'
import { READING_LANGUAGES, UI_LOCALES } from '@tela/shared'
import {
  applyPull,
  blogrollPublicChange,
  type Confirmed,
  emptyTables,
  type Mutation,
  mergeTitles,
  nextTitleIds,
  type Pending,
  type PullResponse,
  type PushResponse,
  privacyChange,
  pruneTitlesTo,
  readingLangOf,
  settle,
  type Tables,
  TITLE_IDS_MAX,
  type TitleRow,
  titlesIn,
  view,
} from '@tela/sync'
import { sql } from 'drizzle-orm'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

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
/**
 * How far behind the server each device's clock runs, in ms. A change advances the server's clock
 * by 1 to 5 ms, so the second device's next change often carries an older `at` than the first's.
 */
const SKEWS = [0, 3]
/**
 * Each device's browser language, which its reading language follows while the account names
 * neither a reading nor an interface language (ADR 0040): the two can hold titles in different
 * languages, and each must still equal a snapshot in its own (ADR 0052).
 */
const BROWSERS = ['fr', 'zh-Hant']

/** What a snapshot and a synced device must agree on, independent of how they got there. */
function live(t: Tables) {
  const subs = [...t.subscriptions.values()].filter((s) => s.deletedAt === null)
  // The blogs in live blogrolls (ADR 0050): a device may still hold a removed one, or one of a
  // blogroll a page ended before, which nothing shows.
  const rolled = [...t.blogrollBlogs.values()]
    .filter((b) => b.removedAt === null && t.blogrolls.has(b.blogrollId))
    .sort((a, b) => a.blogrollId.localeCompare(b.blogrollId) || a.feedId - b.feedId)
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
      .filter(
        (s) =>
          ids.has(s.articleId) &&
          (s.readAt !== null || s.likedAt !== null || s.readUpdatedAt != null),
      )
      .map((s) => ({
        articleId: s.articleId,
        read: s.readAt !== null,
        // Marked unread by hand, which beats the watermark (ADR 0009).
        unread: s.readAt === null && s.readUpdatedAt != null,
        liked: s.likedAt !== null,
      }))
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
    folders: [...t.folders.values()]
      .map((f) => ({ id: f.id, name: f.name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    filed: [...t.feedFolders.values()]
      .filter((f) => f.folderId !== null)
      .map((f) => ({ feedId: f.feedId, folderId: f.folderId }))
      .sort((a, b) => a.feedId - b.feedId),
    blogrolls: [...t.blogrolls.values()]
      .map((r) => ({ id: r.id, name: r.name, description: r.description, isPublic: r.isPublic }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    rolled: rolled.map((b) => ({ blogrollId: b.blogrollId, feedId: b.feedId, note: b.note })),
    // Each blog's feed is held, subscribed or not, so the owner's page can name it.
    rolledFeeds: [...new Set(rolled.map((b) => b.feedId))]
      .filter((id) => t.feeds.has(id))
      .sort((a, b) => a - b),
    flags: {
      publicSubscriptions: t.profile?.publicSubscriptions,
      publicLikes: t.profile?.publicLikes,
      publicSubscriptionsVersion: t.profile?.publicSubscriptionsVersion,
      publicLikesVersion: t.profile?.publicLikesVersion,
      gravatar: t.profile?.gravatar,
    },
    languages: {
      uiLocale: t.profile?.uiLocale,
      readingLang: t.profile?.readingLang,
    },
    // The titles of the articles held: a device holds them in its reading language only, and a
    // pull may bring titles of articles it does not hold, which nothing shows (ADR 0052).
    titles: [...t.titles.values()]
      .filter((row) => ids.has(row.articleId))
      .map((row) => ({ articleId: row.articleId, lang: row.lang, title: row.title }))
      .sort((a, b) => a.articleId - b.articleId || a.lang.localeCompare(b.lang)),
  }
}

type Flag = 'publicSubscriptions' | 'publicLikes'

/**
 * One of the member's devices: what it holds, what it has not had confirmed, and its clock; and,
 * for the privacy invariant, how many hides of each switch the server had applied when it last
 * pulled, which are the hides its confirmed rows hold.
 */
type Device = {
  confirmed: Confirmed
  pending: Pending[]
  skew: number
  hidesSeen: Record<Flag, number>
  /** This browser's language, which the reading language follows when the account names none. */
  browser: string
  /**
   * The language its titles are in, whether it holds that language's titles whole, and how far
   * its fetch of them has come (the store's `titles` record and the engine's pass, ADR 0052).
   */
  titles: { lang: string; whole: boolean; after: number }
}

/**
 * `only` limits the changes a device makes to those `choice`s, so a rare one is met often. `cap`
 * sets `member.maxSubscriptions` (ADR 0063), so a subscribe past it is refused by the server while
 * its device had predicted it.
 */
async function scenario(
  seed: number,
  steps: number,
  only?: readonly number[],
  options: { cap?: number } = {},
) {
  const random = rng(seed)
  const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(random() * xs.length)]
  const api: TestApi = await createTestApi()
  const member: SignedIn = await signedIn(api)
  if (options.cap !== undefined) {
    await api.db.run(sql`insert into settings (key, value, updated_at)
      values ('member.maxSubscriptions', ${JSON.stringify(options.cap)}, 0)`)
  }
  let nextArticle = 1
  const write = (...s: ReturnType<typeof api.db.run>[]) =>
    api.db.batch([bumpSeq(api.db), ...s] as never)
  /** The feed of each article written, so a title row can name it. */
  const feedOf = new Map<number, number>()
  let titleVersions = 0
  /** tela-jobs translating a title, or translating it again: a new row, or a new seq on one. */
  const translate = (articleId: number, lang: string) =>
    write(
      api.db.run(sql`insert into article_titles
          (article_id, lang, feed_id, title, excerpt, status, source_hash, updated_at, seq)
        values (${articleId}, ${lang}, ${feedOf.get(articleId) ?? 1},
          ${`${lang}:Post ${articleId} v${++titleVersions}`}, null, 'done', 'h', ${api.clock.now()}, ${currentSeq})
        on conflict (article_id, lang) do update set title = excluded.title,
          updated_at = excluded.updated_at, seq = excluded.seq`),
    )
  const addArticle = async (feedId: number) => {
    const id = nextArticle++
    feedOf.set(id, feedId)
    await write(
      api.db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at, seq)
        values (${id}, ${feedId}, ${`k${id}`}, ${`Post ${id}`}, ${api.clock.now()}, ${api.clock.now()}, ${currentSeq})`),
    )
    // Its titles, in some of the languages, as the titles job writes them one group at a time.
    for (const lang of READING_LANGUAGES) if (random() < 0.5) await translate(id, lang)
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

  const devices: Device[] = SKEWS.map((skew, i) => ({
    confirmed: { cursor: 0, tables: emptyTables() },
    pending: [],
    skew,
    hidesSeen: { publicSubscriptions: 0, publicLikes: 0 },
    browser: BROWSERS[i] ?? 'en',
    titles: { lang: BROWSERS[i] ?? 'en', whole: false, after: 0 },
  }))
  let mids = 0
  /** Subscribes made while the device's view already held the cap (ADR 0063). */
  let pastCap = 0
  // The privacy invariant (issue #16): a show with a base never applies over a hide its device had
  // not pulled. The server applies a mutation the first time its id arrives, so the hides applied
  // so far are counted here as they are sent; each show records the count its device had seen.
  const sent = new Set<string>()
  const hides: Record<Flag, number> = { publicSubscriptions: 0, publicLikes: 0 }
  const showSeen = new Map<string, { flag: Flag; hides: number }>()
  const versionOf = async (flag: Flag) => {
    const column = flag === 'publicLikes' ? 'public_likes_version' : 'public_subscriptions_version'
    const rows = await api.db.all<{ v: number }>(
      sql`select ${sql.raw(column)} as v from profiles where user_id = ${member.userId}`,
    )
    return Number(rows[0]?.v ?? 0)
  }

  /**
   * The device's reading language, as its view says (a change still pending counts): when it is
   * not the one its titles are in, the titles go at once and the fetch of the new one's starts.
   */
  const follow = (d: Device) => {
    const lang = readingLangOf(view(d.confirmed, d.pending).profile, d.browser)
    if (lang === d.titles.lang) return
    d.confirmed = { ...d.confirmed, tables: pruneTitlesTo(d.confirmed.tables, lang) }
    d.titles = { lang, whole: false, after: 0 }
  }
  /**
   * Pull, naming the language the titles are in, then fetch that language's titles while they are
   * not whole, a page at a time; now and then stop early, as a tab closed mid-way does, for the
   * next pull to carry on. `finish` never stops early. Now and then the member changes language
   * while a pull is on its way, so it lands in the language it was asked in, not the device's.
   */
  const pull = async (d: Device, finish = false) => {
    follow(d)
    for (;;) {
      const res = await api.request(
        `/api/v1/sync?cursor=${d.confirmed.cursor}&titles=${d.titles.lang}`,
        { as: member },
      )
      const body = (await res.json()) as PullResponse
      if (!finish && random() < 0.15) {
        mutate(d, 16)
        follow(d)
      }
      const { pull: taken, folded } = titlesIn(body, d.titles.lang)
      d.confirmed = applyPull(d.confirmed, taken)
      if (!folded) d.titles = { ...d.titles, whole: false, after: 0 }
      else if (body.reset) d.titles = { ...d.titles, whole: true, after: 0 }
      d.pending = settle(d.confirmed, d.pending)
      if (!body.more) break
    }
    d.hidesSeen = { ...hides }
    // A pull can bring the other device's change of language: the app follows it at once
    // (`Routed`'s effect hands the store the language its view names), before any fetch.
    follow(d)
    while (!d.titles.whole) {
      if (!finish && random() < 0.25) break
      const lang = d.titles.lang
      const ids = nextTitleIds(d.confirmed.tables, lang, TITLE_IDS_MAX, d.titles.after)
      if (ids.length === 0) {
        d.titles = { ...d.titles, whole: true }
        break
      }
      const res = await api.request('/api/v1/sync/titles', { body: { lang, ids }, as: member })
      expect(res.status).toBe(200)
      const { rows } = (await res.json()) as { rows: TitleRow[] }
      d.confirmed = { ...d.confirmed, tables: mergeTitles(d.confirmed.tables, rows, lang) }
      d.titles = { ...d.titles, after: ids.at(-1) ?? d.titles.after }
    }
  }
  /**
   * One request. A batch applies in order, so a device's batch is sent in parts, each privacy show
   * with a base alone: the version moving then says that the show applied.
   */
  const send = async (mutations: Mutation[]) => {
    const show = mutations.length === 1 ? mutations[0] : undefined
    const first = show !== undefined && !sent.has(show.mid) ? showSeen.get(show.mid) : undefined
    const before = first ? await versionOf(first.flag) : 0
    for (const m of mutations) {
      if (sent.has(m.mid)) continue
      sent.add(m.mid)
      if (m.type !== 'setPrivacy') continue
      if (m.publicLikes === false) hides.publicLikes++
      if (m.publicSubscriptions === false) hides.publicSubscriptions++
    }
    const res = await api.request('/api/v1/mutations', { body: { mutations }, as: member })
    if (first && (await versionOf(first.flag)) > before) {
      // It applied: no hide of its switch had landed that its device had not pulled.
      expect(hides[first.flag]).toBe(first.hides)
    }
    return (await res.json()) as PushResponse
  }
  const push = async (d: Device, loseResponse: boolean) => {
    const batch = d.pending.filter((p) => p.ackedAt === undefined).slice(0, 50)
    if (batch.length === 0) return
    const parts: Mutation[][] = [[]]
    for (const p of batch) {
      if (showSeen.has(p.mutation.mid)) parts.push([p.mutation], [])
      else parts.at(-1)?.push(p.mutation)
    }
    const answers: PushResponse[] = []
    for (const part of parts) if (part.length > 0) answers.push(await send(part))
    if (loseResponse) return // applied on the server; the device never hears, and sends again
    const seq = Math.max(...answers.map((a) => a.seq))
    const applied = new Set(answers.flatMap((a) => a.applied))
    const rejected = new Set(answers.flatMap((a) => a.rejected.map((r) => r.mid)))
    d.pending = d.pending
      .filter((p) => !rejected.has(p.mutation.mid))
      .map((p) => (applied.has(p.mutation.mid) ? { ...p, ackedAt: seq } : p))
  }
  const mutate = (d: Device, chosen?: number) => {
    const shown = view(d.confirmed, d.pending)
    const articleIds = [...shown.articles.keys()]
    const at = api.clock.now() - d.skew
    api.clock.advance(1 + Math.floor(random() * 5))
    const mid = `seed${seed}-m${++mids}-pad`
    const choice = chosen ?? (only ? (pick(only) as number) : Math.floor(random() * 27))
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
    if (choice === 3 || choice === 4) {
      m = { mid, at, type: 'subscribe', feedId: feed }
      const live = [...shown.subscriptions.values()].filter((s) => s.deletedAt === null)
      if (live.length >= (options.cap ?? Number.POSITIVE_INFINITY)) pastCap++
    }
    if (choice === 5) m = { mid, at, type: 'unsubscribe', feedId: feed }
    if (choice === 6)
      m =
        random() < 0.7
          ? {
              mid,
              at,
              type: 'setPref',
              key: 'reader.mode',
              value: pick(['side', 'orig', 'trans']) as string,
            }
          : // A theme, chosen or taken from this browser, which fills only an absent pref.
            {
              mid,
              at,
              type: 'setPref',
              key: 'ui.theme',
              value: pick(['light', 'dark', 'system']) as string,
              ...(random() < 0.5 ? { ifAbsent: true } : {}),
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
    if (choice === 14) {
      // As Settings makes it: a show names the version in this device's confirmed rows, and waits
      // while a change to its switch is on its way (issue #16). Now and then one without a base,
      // as a shell from before the versions sends it.
      const flag = random() < 0.5 ? 'publicSubscriptions' : 'publicLikes'
      const change = privacyChange(d.confirmed, d.pending, flag, random() < 0.5)
      if (change && random() < 0.2) delete change.base
      if (change) m = { mid, at, ...change }
      if (change?.base) showSeen.set(mid, { flag, hides: d.hidesSeen[flag] })
    }
    if (choice === 15) m = { mid, at, type: 'setAvatar', gravatar: random() < 0.5 }
    if (choice === 16) {
      // Either language, or both; a reading language of null follows the interface (ADR 0040).
      const r = random()
      const uiLocale = r < 0.66 ? pick(UI_LOCALES) : undefined
      const readingLang = r > 0.33 ? pick([...READING_LANGUAGES, null]) : undefined
      m = {
        mid,
        at,
        type: 'setProfile',
        ...(uiLocale === undefined ? {} : { uiLocale }),
        ...(readingLang === undefined ? {} : { readingLang }),
        // Now and then the interface language a visitor chose, taken only while there is none.
        ...(uiLocale !== undefined && random() < 0.25 ? { adopt: true } : {}),
      }
    }
    if (choice === 17 && article) m = { mid, at, type: 'markUnread', articleId: article }
    // Folders (ADR 0048): a new one or a rename of one held, a deletion, and a move to one held
    // or to none.
    const folder = pick([...shown.folders.keys()])
    const name = pick(['Cities', 'Craft', 'Quiet']) as string
    if (choice === 18)
      m = {
        mid,
        at,
        type: 'putFolder',
        id: folder && random() < 0.5 ? folder : `seed${seed}-f${mids}`,
        name,
      }
    if (choice === 19 && folder) m = { mid, at, type: 'deleteFolder', id: folder }
    if (choice === 20)
      m = {
        mid,
        at,
        type: 'fileFeed',
        feedId: feed,
        folderId: folder && random() < 0.8 ? folder : null,
      }
    // Blogrolls (ADR 0050): a new one or an edit of one held, a switch made as the owner's page
    // makes it, a deletion, and a blog put in, taken out or noted.
    const blogroll = pick([...shown.blogrolls.keys()])
    if (choice === 21)
      m = {
        mid,
        at,
        type: 'putBlogroll',
        id:
          blogroll && random() < 0.5
            ? blogroll
            : `R${String(seed).padStart(3, '0')}${String(mids).padStart(8, '0')}`,
        name: pick(['Friends', 'Craft', 'Far away']) as string,
        description: pick(['', 'Blogs I read.', 'Two\nlines']) as string,
        isPublic: random() < 0.5,
      }
    if (choice === 22 && blogroll) {
      const change = blogrollPublicChange(d.confirmed, d.pending, blogroll, random() < 0.6)
      if (change) m = { mid, at, ...change }
    }
    if (choice === 23 && blogroll && random() < 0.5) {
      m = { mid, at, type: 'deleteBlogroll', id: blogroll }
    }
    if (choice === 24 && blogroll) {
      m = { mid, at, type: 'rollBlog', blogrollId: blogroll, feedId: feed }
    }
    if (choice === 25 && blogroll) {
      m = { mid, at, type: 'unrollBlog', blogrollId: blogroll, feedId: feed }
    }
    if (choice === 26 && blogroll) {
      const note = random() < 0.7 ? (pick(['Read this.', 'Quiet, good.']) as string) : null
      m = { mid, at, type: 'noteBlog', blogrollId: blogroll, feedId: feed, note }
    }
    if (m) d.pending.push({ mutation: m })
  }

  for (let i = 0; i < steps; i++) {
    const d = pick(devices) as Device
    const r = random()
    if (r < 0.45) mutate(d)
    else if (r < 0.65) await push(d, random() < 0.25)
    else if (r < 0.88) await pull(d)
    else if (r < 0.93) await addArticle(pick(FEEDS) as number)
    else if (r < 0.97 && nextArticle > 1) {
      await translate(
        1 + Math.floor(random() * (nextArticle - 1)),
        pick(READING_LANGUAGES) as string,
      )
    } else await rename(pick(PEOPLE) as string)
  }

  // Quiescence: everything pushed, everything pulled, by every device, and then each pulls once
  // more, since another device's last push can land after its last pull.
  for (let i = 0; i < 10 && devices.some((d) => d.pending.length > 0); i++) {
    for (const d of devices) {
      await push(d, false)
      await pull(d, true)
    }
  }
  for (const d of devices) await pull(d, true)
  for (const d of devices) {
    // Each device against a fresh snapshot in the language its titles are in, which is the one its
    // view names; it holds that language whole, and no title in any other.
    const lang = d.titles.lang
    expect(lang).toBe(readingLangOf(view(d.confirmed, d.pending).profile, d.browser))
    const snapshot = applyPull(
      { cursor: 0, tables: emptyTables() },
      (await (
        await api.request(`/api/v1/sync?cursor=0&titles=${lang}`, { as: member })
      ).json()) as PullResponse,
    )
    expect(d.pending).toEqual([])
    expect(d.titles.whole).toBe(true)
    expect([...d.confirmed.tables.titles.values()].filter((row) => row.lang !== lang)).toEqual([])
    expect(live(view(d.confirmed, d.pending))).toEqual(live(snapshot.tables))
  }
  if (options.cap !== undefined) {
    // Whatever the devices predicted, the server never held more than the cap.
    const held = await api.db.all<{ n: number }>(sql`select count(*) as n from subscriptions
      where user_id = ${member.userId} and deleted_at is null`)
    expect(Number(held[0]?.n)).toBeLessThanOrEqual(options.cap)
    // And the devices did ask for more than it, so a refusal was met.
    expect(pastCap).toBeGreaterThan(0)
  }
}

describe('sync converges', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    test(`seed ${seed}: two devices, one behind; any interleaving of changes, pushes, lost responses and pulls`, async () => {
      await scenario(seed, 160)
    })
  }
})

describe('folders converge (ADR 0048)', () => {
  // Folders alone, so a rename, a delete and a move meet each other, and the other device's, often.
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`seed ${seed}: two devices making, renaming, deleting and filling folders`, async () => {
      await scenario(seed, 160, [18, 18, 19, 20, 20, 20])
    })
  }
})

describe('blogrolls converge (ADR 0050)', () => {
  // Blogrolls alone, so an edit, a switch, a deletion, and a blog put in, taken out and noted meet
  // each other, and the other device's, often; now and then a subscription, so a blog in a
  // blogroll is sometimes followed and sometimes not.
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`seed ${seed}: two devices keeping blogrolls, their blogs and notes`, async () => {
      await scenario(seed, 200, [21, 21, 22, 22, 23, 24, 24, 24, 25, 25, 26, 26, 3, 5])
    })
  }
})

describe("titles converge in each device's reading language (ADR 0052)", () => {
  // Language changes above all, with reads, recommendations and subscriptions between them: titles
  // are written and rewritten throughout, a change lands while a pull is on its way, and a fetch of
  // a language's titles is cut short and carried on, on two devices whose browsers differ.
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`seed ${seed}: two devices switching reading language while titles are written`, async () => {
      await scenario(seed, 200, [16, 16, 16, 0, 7, 3, 3])
    })
  }
})

describe('the subscription cap converges (ADR 0063)', () => {
  // Subscribes and unsubscribes alone, two of the three feeds allowed: a device predicts a
  // subscribe the server refuses, because the other device's took the last place, and after a pull
  // holds what the server holds. A refusal is a no-op recorded like any other mutation.
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`seed ${seed}: two devices subscribing past a cap of two`, async () => {
      await scenario(seed, 160, [3, 4, 5], { cap: 2 })
    })
  }
})

describe('a privacy show never applies over a hide its device had not pulled (issue #16)', () => {
  // The privacy switches alone, so lost answers, pulls and the other device's hides meet them
  // often: every show that applies is checked as it lands, and the devices still converge.
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`seed ${seed}: two devices toggling both switches`, async () => {
      await scenario(seed, 160, [14])
    })
  }
})
