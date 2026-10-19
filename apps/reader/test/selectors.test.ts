import { describe, expect, test } from 'bun:test'
import { applyMutation, applyPull, emptyTables, type Tables, titleKey, view } from '@tela/sync'
import {
  articlesFor,
  feedsInFolder,
  feedTitle,
  folderIdOf,
  folderTree,
  isMarkedUnread,
  isRead,
  markAllReadCovers,
  markAllReadPlan,
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
    // Everything that asks whether a post is read agrees: counts, the Unread list and the prefetch.
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

describe('what a mark-all-read reads', () => {
  const state = (articleId: number, readAt: number | null, readUpdatedAt: number | null) => ({
    articleId,
    readAt,
    readUpdatedAt,
    likedAt: null,
    likedUpdatedAt: null,
    seq: 1,
  })
  const AT = NOW - 1000
  const markAll = (upTo: number, feedId?: number) => ({
    type: 'markAllRead' as const,
    mid: 'mark-all-1',
    at: AT,
    upTo,
    ...(feedId === undefined ? {} : { feedId }),
  })
  // Feed 1 has read up to 2 by its watermark; 3 to 6 are above it. Feed 2 is another blog,
  // and feed 3 one the member left.
  const t = tables({
    subscriptions: [sub(1, { watermarkId: 2 }), sub(2), sub(3, { deletedAt: 5 })],
    articles: [
      article(1),
      // Under the watermark, but marked unread by hand before the mark-all.
      article(2),
      article(3),
      // Marked unread by hand before the mark-all, and since it.
      article(4),
      article(5),
      // Past the horizon: read already, whatever the mark-all does.
      article(6, { fetchedAt: NOW - 31 * DAY }),
      // Read by opening it.
      article(7),
      article(8, { feedId: 2 }),
      article(9, { feedId: 3 }),
      // Above what the list showed.
      article(10),
    ],
    states: [
      state(2, null, AT - 10),
      state(4, null, AT - 5),
      state(5, null, AT + 5),
      state(7, 3, null),
    ],
  })

  test('counts every post it turns read, under the watermark or above it', () => {
    expect(markAllReadCovers(t, markAll(9, 1), NOW).sort((a, b) => a - b)).toEqual([2, 3, 4])
  })

  test('across every feed the member follows, without one named', () => {
    expect(markAllReadCovers(t, markAll(9), NOW).sort((a, b) => a - b)).toEqual([2, 3, 4, 8])
  })

  test('nothing past the horizon, in another feed, above upTo, or marked unread since', () => {
    const covered = markAllReadCovers(t, markAll(9, 1), NOW)
    for (const id of [5, 6, 7, 8, 9, 10]) expect(covered).not.toContain(id)
    // The answer agrees with what the list then shows.
    expect(covered.every((id) => !isRead(t, t.articles.get(id) ?? article(id), NOW))).toBe(true)
    expect(markAllReadCovers(t, markAll(1, 1), NOW)).toEqual([])
  })

  test('nothing once a mark-all over it is already shown: a second press has nothing to send', () => {
    // The first press, held for its Undo, is in the view the second one counts against.
    const once = applyMutation(t, markAll(9, 1))
    expect(markAllReadCovers(once, { ...markAll(9, 1), mid: 'mark-all-2' }, NOW)).toEqual([])
    // One feed's after every feed's, the same.
    const all = applyMutation(t, markAll(9))
    expect(markAllReadCovers(all, { ...markAll(9, 1), mid: 'mark-all-2' }, NOW)).toEqual([])
    // Every feed's after one feed's still reads the others.
    expect(markAllReadCovers(once, { ...markAll(9), mid: 'mark-all-2' }, NOW)).toEqual([8])
  })

  const plan = (at: Tables, where: { feedId: number | null; folderId: string | null }) =>
    markAllReadPlan(at, where, 9, AT)
      .map(({ input, covered }) => ({ input, covered: covered.sort((a, b) => a - b) }))
      .sort((a, b) => (a.input.feedId ?? 0) - (b.input.feedId ?? 0))

  test('one mark-all for a blog or for everything followed, as the list asks', () => {
    expect(plan(t, { feedId: 1, folderId: null })).toEqual([
      { input: { type: 'markAllRead', upTo: 9, feedId: 1 }, covered: [2, 3, 4] },
    ])
    expect(plan(t, { feedId: null, folderId: null })).toEqual([
      { input: { type: 'markAllRead', upTo: 9 }, covered: [2, 3, 4, 8] },
    ])
  })

  test("a folder's is one per blog followed in it, and none for a blog it would not read", () => {
    const folder = { id: 'f-cities', name: 'Cities', createdAt: 1, updatedAt: 1, seq: 1 }
    const filed = (feedId: number) => ({ feedId, folderId: 'f-cities', updatedAt: 1, seq: 1 })
    const inFolder = tables({
      // 1 and 2 as above; 3 was left; 4 has only a post read already; 5 is in no folder.
      subscriptions: [sub(1, { watermarkId: 2 }), sub(2), sub(3, { deletedAt: 5 }), sub(4), sub(5)],
      folders: [{ ...folder, deletedAt: null }],
      feedFolders: [filed(1), filed(2), filed(3), filed(4)],
      articles: [
        article(1),
        article(2),
        article(3),
        article(4, { feedId: 2 }),
        article(5, { feedId: 3 }),
        article(6, { feedId: 4 }),
        article(7, { feedId: 5 }),
      ],
      states: [state(2, null, AT - 10), state(6, 3, null)],
    })
    const marks = plan(inFolder, { feedId: null, folderId: 'f-cities' })
    expect(marks).toEqual([
      { input: { type: 'markAllRead', upTo: 9, feedId: 1 }, covered: [2, 3] },
      { input: { type: 'markAllRead', upTo: 9, feedId: 2 }, covered: [4] },
    ])
    // What the toast counts is everything the group reads, and nothing outside the folder.
    expect(marks.flatMap((m) => m.covered)).toEqual([2, 3, 4])
    // A folder gone has nothing to read, and so sends nothing.
    expect(plan(inFolder, { feedId: null, folderId: 'f-deleted' })).toEqual([])
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

  test('a second feed of a blog arriving in a pull renames the first, which was named already', () => {
    const one = applyPull(
      { cursor: 0, tables: emptyTables() },
      pull(1, { feeds: [feed(1, 1, 'Posts')], sites: [site(1, 'One Blog')] }, true),
    )
    expect(feedTitle(view(one, []), 1)).toBe('One Blog')
    const two = view(applyPull(one, pull(2, { feeds: [feed(2, 1, 'Links')] })), [])
    expect([feedTitle(two, 1), feedTitle(two, 2)]).toEqual(['Posts', 'Links'])
  })
})

describe('folders (ADR 0048)', () => {
  const folder = (id: string, name: string) => ({
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    seq: 1,
  })
  const filed = (feedId: number, folderId: string | null) => ({
    feedId,
    folderId,
    updatedAt: 1,
    seq: 1,
  })
  const feed = (id: number, title: string) => ({
    id,
    siteId: id,
    feedUrl: `https://blog${id}.example/feed`,
    title,
    status: 'active',
    lastFetchedAt: null,
    lastError: null,
    seq: 1,
  })
  const t = tables({
    subscriptions: [sub(1), sub(2), sub(3), sub(4, { deletedAt: 5 })],
    feeds: [feed(1, 'Zebra'), feed(2, 'apple'), feed(3, 'Mango'), feed(4, 'Left')],
    folders: [folder('f-craft', 'craft'), folder('f-cities', 'Cities'), folder('f-empty', 'Bare')],
    feedFolders: [filed(1, 'f-cities'), filed(2, 'f-cities'), filed(4, 'f-craft'), filed(3, null)],
    articles: [article(1, { feedId: 1 }), article(2, { feedId: 2 }), article(3, { feedId: 2 })],
  })

  test('folders by name, each with the blogs followed in it by title, then the rest', () => {
    const tree = folderTree(t, NOW)
    expect(tree.folders.map((f) => [f.name, f.blogs.map((b) => b.title), f.unread])).toEqual([
      ['Bare', [], 0],
      ['Cities', ['apple', 'Zebra'], 3],
      // Its only blog was left: the folder stays, empty.
      ['craft', [], 0],
    ])
    expect(tree.unfiled.map((b) => b.title)).toEqual(['Mango'])
  })

  test('a blog filed in a folder since deleted, or never held, is in none', () => {
    const gone = tables({
      subscriptions: [sub(1), sub(2)],
      feeds: [feed(1, 'One'), feed(2, 'Two')],
      folders: [],
      feedFolders: [filed(1, 'f-deleted'), filed(2, null)],
    })
    expect(folderIdOf(gone, 1)).toBeNull()
    expect(folderTree(gone, NOW).unfiled.map((b) => b.feedId)).toEqual([1, 2])
  })

  test("a folder's feeds are those followed in it", () => {
    expect(feedsInFolder(t, 'f-cities').sort()).toEqual([1, 2])
    expect(feedsInFolder(t, 'f-craft')).toEqual([])
  })

  test("a folder lists its followed blogs' posts, newest first, and one gone lists none", () => {
    const listed = tables({
      subscriptions: [sub(1), sub(2), sub(3), sub(4, { deletedAt: 5 })],
      feeds: [feed(1, 'Zebra'), feed(2, 'apple'), feed(3, 'Mango'), feed(4, 'Left')],
      folders: [folder('f-cities', 'Cities'), folder('f-craft', 'craft')],
      feedFolders: [filed(1, 'f-cities'), filed(2, 'f-cities'), filed(4, 'f-cities')],
      articles: [
        article(1, { feedId: 1, sortAt: NOW - 3 * DAY }),
        article(2, { feedId: 2, sortAt: NOW - DAY }),
        article(3, { feedId: 3, sortAt: NOW - DAY / 2 }),
        // Filed in the folder, but the member left the blog.
        article(4, { feedId: 4, sortAt: NOW - DAY / 4 }),
        article(5, { feedId: 1, sortAt: NOW - DAY / 8 }),
      ],
    })
    const ids = (at: Tables, folderId: string | null, feedId: number | null = null) =>
      articlesFor(at, { filter: 'all', feedId, folderId }, NOW).map((a) => a.id)
    expect(ids(listed, 'f-cities')).toEqual([5, 2, 1])
    expect(ids(listed, 'f-craft')).toEqual([])
    expect(ids(listed, 'f-deleted')).toEqual([])
    // Each folder its own answer, and none of them the list of everything or of one blog.
    expect(ids(listed, null)).toEqual([5, 3, 2, 1])
    expect(ids(listed, null, 1)).toEqual([5, 1])
    // A blog moved out is out of the folder's list in the very next tables.
    const moved = applyMutation(listed, {
      type: 'fileFeed',
      mid: 'move-1',
      at: NOW,
      feedId: 2,
      folderId: 'f-craft',
    })
    expect(ids(moved, 'f-cities')).toEqual([5, 1])
    expect(ids(moved, 'f-craft')).toEqual([2])
  })
})
