import { describe, expect, test } from 'bun:test'
import { emptyTables, type Tables } from '@tela/sync'
import {
  articlesApiPath,
  articlesHref,
  blogsApiPath,
  blogsHref,
  legacyDiscover,
  parseArticlesParams,
  parseBlogsParams,
  tabHref,
  tabOf,
} from '../src/lib/discover-href'
import { followedAmong, hiddenOf, NOTHING_HIDDEN, postReason } from '../src/lib/discover-overlay'
import { composeWeek } from '../src/lib/discover-week'
import { publicExcerpt } from '../src/lib/public-title'
import { mineOf, suggestReaders } from '../src/lib/suggest-readers'
import type {
  DiscoverPost,
  DiscoverSite,
  ReaderCandidate,
  ReaderPost,
  WeekData,
} from '../src/views/types'
import { article, sub } from './rows'

const site = (id: number) => ({
  id,
  title: `Blog ${id}`,
  homeUrl: `https://blog${id}.example`,
  faviconKey: null,
  primaryLang: 'en',
  claimed: false,
})

/** A post of blog `siteId`, whose feed has the same id. */
function post(id: number, siteId: number, over: Partial<DiscoverPost> = {}): DiscoverPost {
  return {
    article: article(id, { feedId: siteId }),
    site: site(siteId),
    weekRecs: 0,
    recommenders: [],
    note: null,
    ...over,
  }
}

function blog(id: number): DiscoverSite {
  return {
    ...site(id),
    description: null,
    readerCount: null,
    feedId: id,
    latestTitle: null,
    latestAt: null,
    postsLast30d: 0,
    topics: [],
  }
}

function reader(id: string, over: Partial<ReaderCandidate> = {}): ReaderCandidate {
  return {
    id,
    handle: id,
    displayName: null,
    avatar: null,
    bio: null,
    recs: [],
    sites: null,
    recent: 0,
    withNote: 0,
    total: 0,
    early: null,
    sample: null,
    ...over,
  }
}

const readerPost = (id: number, siteId: number): ReaderPost => ({
  article: article(id, { feedId: siteId }),
  site: site(siteId),
})

/** A device that reads blogs `reads` (feed id = site id), and liked `liked`. */
function tables(reads: number[] = [], liked: number[] = []): Tables {
  const t = emptyTables()
  for (const id of reads) {
    t.subscriptions.set(id, sub(id))
    t.feeds.set(id, {
      id,
      siteId: id,
      feedUrl: `https://blog${id}.example/feed`,
      title: null,
      status: 'ok',
      lastFetchedAt: null,
      lastError: null,
      seq: 1,
    })
    t.sites.set(id, {
      id,
      homeUrl: `https://blog${id}.example`,
      title: `Blog ${id}`,
      description: null,
      faviconKey: null,
      primaryLang: 'en',
      listing: 'listed',
      owned: false,
      claimed: false,
      readerCount: 0,
      translationOptOut: false,
      seq: 1,
    })
  }
  for (const id of liked) {
    t.articles.set(id, article(id, { title: `Liked ${id}` }))
    t.states.set(id, { articleId: id, readAt: null, likedAt: 1, likedUpdatedAt: 1, seq: 1 })
  }
  return t
}

const reading = { lang: 'en', never: [] as string[] }

describe('Discover URLs', () => {
  test('each tab has its own path, and This week is Discover itself', () => {
    expect(tabHref('week')).toBe('/discover')
    expect(tabHref('readers')).toBe('/discover/readers')
    expect(tabOf('/discover')).toBe('week')
    expect(tabOf('/discover/articles')).toBe('articles')
    expect(tabOf('/discover/nope')).toBeNull()
    expect(tabOf('/discover/blogs/')).toBeNull()
  })

  test('the Blogs page moved, and its endpoint stayed', () => {
    const params = parseBlogsParams(new URLSearchParams('topic=tech&lang=ja&page=2&utm=x'))
    expect(blogsHref(params)).toBe('/discover/blogs?topic=tech&lang=ja&page=2')
    expect(blogsApiPath(params)).toBe('/api/v1/public/discover?topic=tech&lang=ja&page=2')
  })

  test('Articles sorts on the device: the endpoint never names the sort', () => {
    const params = parseArticlesParams(new URLSearchParams('sort=new&topic=food&cursor=123:45'))
    expect(params).toEqual({ topic: 'food', lang: null, sort: 'new', cursor: '123:45' })
    expect(articlesHref(params)).toBe('/discover/articles?topic=food&sort=new&cursor=123%3A45')
    expect(articlesApiPath(params)).toBe(
      '/api/v1/public/discover/articles?topic=food&cursor=123%3A45',
    )
    expect(articlesHref({ ...params, sort: 'recs', cursor: null })).toBe(
      '/discover/articles?topic=food',
    )
  })

  test('a cursor that is not one, or a sort that is not one, is the default', () => {
    const params = parseArticlesParams(new URLSearchParams('sort=old&cursor=1:2;drop'))
    expect(params.sort).toBe('recs')
    expect(params.cursor).toBeNull()
  })

  test('an address from before the tabs keeps its whole query on the Blogs page', () => {
    expect(legacyDiscover('/discover', '?topic=tech&door=login&via=github')).toBe(
      '/discover/blogs?topic=tech&door=login&via=github',
    )
    expect(legacyDiscover('/discover', '?page=3')).toBe('/discover/blogs?page=3')
    expect(legacyDiscover('/discover', '?utm_source=x')).toBeNull()
    expect(legacyDiscover('/discover', '')).toBeNull()
    expect(legacyDiscover('/discover/articles', '?topic=tech')).toBeNull()
  })
})

describe('the device on Discover', () => {
  test('a blog the member reads is hidden by site, and by feed when its site is unknown', () => {
    const t = tables([3])
    t.subscriptions.set(9, sub(9))
    t.subscriptions.set(4, sub(4, { deletedAt: 5 }))
    const hidden = hiddenOf(t)
    expect(hidden(3)).toBe(true)
    expect(hidden(77, 9)).toBe(true)
    expect(hidden(4, 4)).toBe(false)
    expect(NOTHING_HIDDEN(3, 3)).toBe(false)
  })

  test('whom you follow comes first, else the week count, else nothing', () => {
    const t = emptyTables()
    t.follows.set('ann', {
      userId: 'ann',
      handle: 'ann',
      displayName: 'Ann',
      avatar: null,
      createdAt: 0,
      deletedAt: null,
      seq: 1,
    })
    // A follow the pull has not named yet is named by the post's note.
    t.follows.set('bo', {
      userId: 'bo',
      handle: null,
      displayName: null,
      avatar: null,
      createdAt: 0,
      deletedAt: null,
      seq: 1,
    })
    const p = post(1, 1, {
      weekRecs: 4,
      recommenders: ['zed', 'bo', 'ann'],
      note: { text: 'Good', person: { id: 'bo', handle: 'bo', displayName: 'Bo', avatar: null } },
    })
    const followed = followedAmong(p, t.follows)
    expect(followed.map((x) => x.handle)).toEqual(['bo', 'ann'])
    expect(postReason(p, followed)).toEqual({ kind: 'followed', people: followed, others: 1 })
    expect(postReason(p, [])).toEqual({ kind: 'week', count: 4 })
    expect(postReason(post(2, 2), [])).toBeNull()
  })

  test('the others beside whom you follow are counted from the post, not the twenty named', () => {
    const named = Array.from({ length: 20 }, (_, i) => `r${i}`)
    const busy = post(3, 3, { article: article(3, { recommendCount: 25 }), recommenders: named })
    const ann = { id: 'r0', handle: 'ann', displayName: 'Ann', avatar: null }
    expect(postReason(busy, [ann])).toMatchObject({ kind: 'followed', others: 24 })
  })

  test('a translated excerpt shows only beside a translated title', () => {
    const fr = { ...article(1, { sourceLang: 'fr', excerpt: 'Bonjour' }) }
    const both = { ...fr, titles: { en: 'Hello' }, excerpts: { en: 'Hi there' } }
    expect(publicExcerpt(both, reading)).toBe('Hi there')
    expect(publicExcerpt(both, { lang: 'en', never: ['fr'] })).toBe('Bonjour')
    expect(publicExcerpt({ ...fr, excerpts: { en: 'Hi there' } }, reading)).toBe('Bonjour')
    expect(publicExcerpt({ ...both, titles: { en: 'Hello' }, excerpts: {} }, reading)).toBe(
      'Bonjour',
    )
  })
})

describe('This week', () => {
  const edition = (posts: DiscoverPost[], span: 'week' | 'latest' = 'week') => ({ span, posts })
  const week = (over: Partial<WeekData>): WeekData => ({
    since: 0,
    recommended: [],
    edition: edition([]),
    newBlogs: [],
    readers: [],
    ...over,
  })

  test('leads with the edition until three recommended posts are left to lead with', () => {
    const w = week({
      recommended: [post(1, 1, { weekRecs: 3 }), post(2, 2, { weekRecs: 1 })],
      edition: edition([post(10, 10), post(11, 11)]),
    })
    const composed = composeWeek(w, NOTHING_HIDDEN)
    expect(composed.span).toBe('week')
    expect(composed.lead?.article.id).toBe(10)
    expect(composed.rest.map((p) => p.article.id)).toEqual([11])
    expect(
      composeWeek({ ...w, edition: edition([post(10, 10)], 'latest') }, NOTHING_HIDDEN).span,
    ).toBe('latest')
  })

  test('tops the recommended up from the edition, with no post or blog twice', () => {
    const w = week({
      recommended: [post(1, 1), post(2, 2), post(3, 3)],
      edition: edition([post(1, 1), post(20, 2), post(30, 30), post(40, 40), post(50, 50)]),
    })
    const composed = composeWeek(w, NOTHING_HIDDEN)
    expect(composed.span).toBe('recommended')
    expect([composed.lead, ...composed.rest].map((p) => p?.article.id)).toEqual([1, 2, 3, 30, 40])
  })

  test("the member's own blogs leave the week, and may leave too few to lead with", () => {
    const w = week({
      recommended: [post(1, 1), post(2, 2), post(3, 3)],
      edition: edition([post(10, 10), post(11, 1)]),
      newBlogs: [blog(1), blog(5), blog(6), blog(7), blog(8)],
    })
    const composed = composeWeek(w, hiddenOf(tables([1])))
    expect(composed.span).toBe('week')
    expect(composed.lead?.article.id).toBe(10)
    expect(composed.rest).toEqual([])
    expect(composed.newBlogs.map((b) => b.id)).toEqual([5, 6, 7])
  })
})

describe('suggested readers', () => {
  const pool = [
    reader('quiet'),
    reader('noter', { recent: 3, withNote: 2, total: 5 }),
    reader('early', { recent: 1, total: 1, early: { ...readerPost(8, 8), others: 3 } }),
    reader('reads', { recent: 1, total: 1, sites: [2, 3, 4] }),
    reader('recs', { recent: 1, total: 1, recs: [[60, 3]] }),
    reader('shared', { recent: 2, total: 2, recs: [[50, 9]] }),
    reader('active', { recent: 1, total: 1 }),
    reader('me', { recent: 9, total: 9, recs: [[50, 9]] }),
  ]

  test('each reader once, in the first group that fits, and the groups in order', () => {
    const mine = mineOf(tables([2, 3], [50]), new Set(['me']), reading)
    const got = suggestReaders(pool, mine).map((s) => [s.person.handle, s.group])
    expect(got).toEqual([
      ['shared', 'shared'],
      ['reads', 'blogs'],
      ['recs', 'blogs'],
      ['early', 'early'],
      ['noter', 'notes'],
      ['active', 'active'],
    ])
  })

  test('a reason names the one post or blog it is about, as the member reads it', () => {
    const mine = mineOf(tables([2, 3], [50]), new Set(['me']), reading)
    const reasons = Object.fromEntries(
      suggestReaders(pool, mine).map((s) => [s.person.handle, s.reason]),
    )
    expect(reasons.shared).toEqual({ kind: 'shared', count: 1, title: 'Liked 50' })
    expect(reasons.recs).toEqual({ kind: 'blogs', via: 'recs', count: 1, blog: 'Blog 3' })
    expect(reasons.reads).toEqual({ kind: 'blogs', via: 'reads', count: 2, blog: null })
  })

  test('a visitor gets only what needs nothing of theirs', () => {
    const got = suggestReaders(pool, null).map((s) => s.group)
    expect(new Set(got)).toEqual(new Set(['early', 'notes', 'active']))
    expect(got).not.toContain('shared')
  })

  test('whom the member follows stays out; notes count from two on half the month', () => {
    const mine = mineOf(tables(), new Set(['me', 'early']), reading)
    const got = suggestReaders(
      [...pool, reader('one-note', { recent: 1, withNote: 1, total: 1 })],
      mine,
    )
    expect(got.map((s) => s.person.handle)).not.toContain('early')
    expect(got.find((s) => s.person.handle === 'one-note')?.group).toBe('active')
    expect(got.find((s) => s.person.handle === 'noter')?.group).toBe('notes')
  })
})
