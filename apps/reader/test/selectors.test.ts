import { describe, expect, test } from 'bun:test'
import { applyPull, emptyTables, type Tables, titleKey, view } from '@tela/sync'
import {
  articlesFor,
  feedTitle,
  isMarkedUnread,
  isRead,
  prefetchPlan,
  shownRead,
  shownTitle,
  subscriptionItems,
  totals,
  withoutRead,
} from '../src/store/selectors'
import { article, DAY, NOW, pull, sub } from './rows'

function tables(rows: Parameters<typeof pull>[1]): Tables {
  return view(applyPull({ cursor: 0, tables: emptyTables() }, pull(1, rows, true)), [])
}

describe('what the reading view shows', () => {
  test('an article is read once opened, under its watermark, or past the horizon', () => {
    const t = tables({
      subscriptions: [sub(1, { watermarkId: 2 })],
      articles: [article(1), article(3), article(4), article(5, { fetchedAt: NOW - 31 * DAY })],
      states: [{ articleId: 4, readAt: 1, likedAt: null, likedUpdatedAt: null, seq: 1 }],
    })
    const read = (id: number) => isRead(t, t.articles.get(id) ?? article(id), NOW)
    expect([1, 3, 4, 5].map(read)).toEqual([true, false, true, true])
  })

  test('a post marked unread beats the watermark and the horizon, until it is read again', () => {
    const state = (articleId: number, readAt: number | null, readUpdatedAt: number | null) => ({
      articleId,
      readAt,
      readUpdatedAt,
      likedAt: null,
      likedUpdatedAt: null,
      seq: 1,
    })
    const t = tables({
      subscriptions: [sub(1, { watermarkId: 3 })],
      articles: [
        article(1),
        article(2, { fetchedAt: NOW - 31 * DAY, contentKey: 'k2' }),
        article(3),
        article(4, { contentKey: 'k4' }),
      ],
      // 1 marked unread under the watermark, 2 past the horizon, 3 read again since; 4 is new.
      states: [state(1, null, 5), state(2, null, 5), state(3, 6, 6)],
    })
    const read = (id: number) => isRead(t, t.articles.get(id) ?? article(id), NOW)
    expect([1, 2, 3, 4].map(read)).toEqual([false, false, true, false])
    expect([1, 2, 3, 4].map((id) => isMarkedUnread(t, id))).toEqual([true, true, false, false])
    // Everything that asks whether a post is read agrees: counts, hide-read and the prefetch.
    expect(totals(t, NOW).all).toBe(3)
    expect(subscriptionItems(t, NOW).map((s) => s.unread)).toEqual([3])
    const list = articlesFor(t, { filter: 'all', feedId: null }, NOW)
    expect(withoutRead(t, list, NOW, null, new Set()).map((a) => a.id)).toEqual([4, 2, 1])
    expect(prefetchPlan(t, list, NOW, 'en', { autoTranslate: false, never: [] }).bodies).toEqual([
      'k4',
      'k2',
    ])
  })

  test('the open post shows as read while opening reads it, until it is marked unread', () => {
    const t = tables({
      subscriptions: [sub(1)],
      articles: [article(1), article(2), article(3)],
      // 1 not read yet (its open's markRead has not landed), 2 marked unread, 3 read.
      states: [
        {
          articleId: 2,
          readAt: null,
          readUpdatedAt: 5,
          likedAt: null,
          likedUpdatedAt: null,
          seq: 1,
        },
        { articleId: 3, readAt: 4, likedAt: null, likedUpdatedAt: null, seq: 1 },
      ],
    })
    const shown = (id: number, open: boolean, markOnOpen: boolean) =>
      shownRead(t, t.articles.get(id) ?? article(id), NOW, open, markOnOpen)
    // Open, with opening reading it: only the one marked unread shows unread.
    expect([1, 2, 3].map((id) => shown(id, true, true))).toEqual([true, false, true])
    // Marking read by hand, or not open: as the tables say.
    expect([1, 2, 3].map((id) => shown(id, true, false))).toEqual([false, false, true])
    expect([1, 2, 3].map((id) => shown(id, false, true))).toEqual([false, false, true])
  })

  test('lists newest first; Today is a day; Liked spans feeds the member left', () => {
    const t = tables({
      subscriptions: [sub(1), sub(2, { deletedAt: 5 })],
      articles: [
        article(1, { sortAt: NOW - 3 * DAY }),
        article(2, { sortAt: NOW - DAY / 2 }),
        article(3, { feedId: 2, sortAt: NOW - DAY / 4 }),
      ],
      states: [{ articleId: 3, readAt: 1, likedAt: 2, likedUpdatedAt: 2, seq: 1 }],
    })
    const ids = (filter: 'all' | 'today' | 'liked', feedId: number | null = null) =>
      articlesFor(t, { filter, feedId }, NOW).map((a) => a.id)
    expect(ids('all')).toEqual([2, 1])
    expect(ids('today')).toEqual([2])
    expect(ids('liked')).toEqual([3])
    expect(ids('all', 1)).toEqual([2, 1])
    expect(totals(t, NOW)).toEqual({ all: 2, today: 1, liked: 1 })
    expect(subscriptionItems(t, NOW).map((s) => [s.feedId, s.unread])).toEqual([[1, 2]])
  })

  test('shows the translated title whenever there is one, and badges it only across languages', () => {
    const t = tables({
      subscriptions: [sub(1)],
      articles: [article(1, { sourceLang: 'ja' }), article(2, { sourceLang: null })],
      titles: [
        { articleId: 1, lang: 'en', title: 'en: one', excerpt: null, status: 'done', seq: 1 },
        { articleId: 2, lang: 'en', title: 'en: two', excerpt: null, status: 'done', seq: 1 },
      ],
    })
    expect(t.titles.has(titleKey(1, 'en'))).toBe(true)
    expect(shownTitle(t, article(1, { sourceLang: 'ja' }), 'en')).toMatchObject({
      title: 'en: one',
      badge: true,
    })
    expect(shownTitle(t, article(2, { sourceLang: null }), 'en')).toMatchObject({
      title: 'en: two',
      badge: false,
    })
    expect(shownTitle(t, article(1, { sourceLang: 'ja' }), 'zh-Hans')).toMatchObject({
      title: 'Post 1',
      badge: false,
    })
  })
})

describe('what the idle prefetch would fetch', () => {
  const translation = (contentKey: string, state: string, objectKey: string | null) => ({
    contentKey,
    lang: 'en',
    state,
    chunkKeys: [],
    objectKey,
    failedLeaves: [],
    seq: 1,
  })
  const rows = {
    subscriptions: [sub(1), sub(2)],
    articles: [
      article(1, { contentKey: 'c1', sortAt: NOW - 1 * DAY }),
      article(2, { contentKey: 'c2', feedId: 2, sourceLang: 'ja', sortAt: NOW - 2 * DAY }),
      article(3, { contentKey: 'c3', sortAt: NOW - 3 * DAY }),
      article(4, { sortAt: NOW - 4 * DAY }),
      article(5, { contentKey: 'c5', feedId: 2, sourceLang: 'de', sortAt: NOW - 5 * DAY }),
      article(6, { contentKey: 'c6', feedId: 2, sourceLang: 'ja', sortAt: NOW - 6 * DAY }),
    ],
    states: [{ articleId: 3, readAt: 1, likedAt: null, likedUpdatedAt: null, seq: 1 }],
    translations: [
      translation('c2', 'done', 't/c2/en/a.json'),
      translation('c5', 'partial', 't/c5/en/b.json'),
      translation('c6', 'running', null),
    ],
  }
  const prefs = { autoTranslate: true, never: [] as string[] }

  test('unread bodies, the list on screen first, then the finished translations it would open', () => {
    const t = tables(rows)
    const list = articlesFor(t, { filter: 'all', feedId: 2 }, NOW)
    expect(prefetchPlan(t, list, NOW, 'en', prefs)).toEqual({
      bodies: ['c2', 'c5', 'c6', 'c1'],
      translations: ['t/c2/en/a.json', 't/c5/en/b.json'],
    })
    // None in a language read as written, and none while translation waits to be asked for.
    expect(
      prefetchPlan(t, list, NOW, 'en', { autoTranslate: true, never: ['de'] }).translations,
    ).toEqual(['t/c2/en/a.json'])
    expect(
      prefetchPlan(t, list, NOW, 'en', { autoTranslate: false, never: [] }).translations,
    ).toEqual([])
  })

  test('is the same after a pull that brings nothing, and changes with what it would fetch', () => {
    const confirmed = applyPull({ cursor: 0, tables: emptyTables() }, pull(1, rows, true))
    const plan = (t: Tables) =>
      JSON.stringify(
        prefetchPlan(t, articlesFor(t, { filter: 'all', feedId: null }, NOW), NOW, 'en', prefs),
      )
    const before = view(confirmed, [])
    // Every pull makes new tables, an empty one too: what the prefetch was keyed on before.
    const empty = view(applyPull(confirmed, pull(2, {})), [])
    expect(empty).not.toBe(before)
    expect(plan(empty)).toBe(plan(before))
    const opened = view(
      applyPull(
        confirmed,
        pull(2, {
          states: [{ articleId: 1, readAt: 2, likedAt: null, likedUpdatedAt: null, seq: 2 }],
        }),
      ),
      [],
    )
    expect(plan(opened)).not.toBe(plan(before))
    const finished = view(
      applyPull(
        confirmed,
        pull(2, { translations: [translation('c6', 'done', 't/c6/en/c.json')] }),
      ),
      [],
    )
    expect(plan(finished)).not.toBe(plan(before))
  })
})

describe('what a feed is called', () => {
  const feed = (id: number, siteId: number, title: string | null) => ({
    id,
    siteId,
    feedUrl: `https://blog${siteId}.example/feed${id}`,
    title,
    status: 'active',
    lastFetchedAt: null,
    lastError: null,
    seq: 1,
  })
  const site = (id: number, title: string | null) => ({
    id,
    homeUrl: `https://blog${id}.example`,
    title,
    description: null,
    faviconKey: null,
    primaryLang: 'fr',
    listing: 'featured',
    owned: false,
    claimed: false,
    readerCount: 0,
    translationOptOut: false,
    seq: 1,
  })

  test("the blog's name, which an editor set and no fetch rewrites, then the feed's, then the host", () => {
    const t = tables({
      feeds: [feed(1, 1, 'feed - Thierry Crouzet'), feed(2, 2, 'A feed'), feed(3, 3, null)],
      sites: [site(1, 'Thierry Crouzet'), site(2, null), site(3, null)],
    })
    expect(feedTitle(t, 1)).toBe('Thierry Crouzet')
    expect(feedTitle(t, 2)).toBe('A feed')
    expect(feedTitle(t, 3)).toBe('blog3.example')
    expect(feedTitle(t, 99)).toBe('')
  })

  test('two feeds of one blog keep their own titles, so a member can tell them apart', () => {
    const t = tables({
      feeds: [feed(1, 1, 'Posts'), feed(2, 1, 'Links')],
      sites: [site(1, 'One Blog')],
    })
    expect([feedTitle(t, 1), feedTitle(t, 2)]).toEqual(['Posts', 'Links'])
  })
})
