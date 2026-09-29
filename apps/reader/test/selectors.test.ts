import { describe, expect, test } from 'bun:test'
import { applyPull, emptyTables, type Tables, titleKey, view } from '@tela/sync'
import { articlesFor, isRead, shownTitle, subscriptionItems, totals } from '../src/store/selectors'
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
