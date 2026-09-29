import { describe, expect, test } from 'bun:test'
import { applyPull, emptyTables, view } from '@tela/sync'
import { mergeHits, normalizeQuery, searchLocal } from '../src/lib/search'
import { article, pull, sub } from './rows'

const t = view(
  applyPull(
    { cursor: 0, tables: emptyTables() },
    pull(
      1,
      {
        subscriptions: [sub(1), sub(2, { deletedAt: 3 })],
        articles: [
          article(1, { title: 'Garden notes' }),
          article(2, { title: '庭の手入れ', sourceLang: 'ja' }),
          article(3, { feedId: 2, title: 'Garden of a feed I left' }),
        ],
        titles: [
          {
            articleId: 2,
            lang: 'en',
            title: 'Tending the garden',
            excerpt: null,
            status: 'done',
            seq: 1,
          },
        ],
      },
      true,
    ),
  ),
  [],
)

describe('search on the device', () => {
  test("matches original and translated titles in the member's feeds, newest first", () => {
    const hits = searchLocal(t, '  GARDEN ', 'en')
    expect(hits.map((h) => [h.article.id, h.translatedTitle])).toEqual([
      [2, 'Tending the garden'],
      [1, null],
    ])
    expect(searchLocal(t, '庭', 'en').map((h) => h.article.id)).toEqual([2])
    expect(searchLocal(t, '', 'en')).toEqual([])
  })

  test("adds the server's hits the device did not have, once each", () => {
    const local = searchLocal(t, 'garden', 'en')
    const remote = [
      { article: article(1), translatedTitle: null },
      { article: article(9, { title: 'An old garden' }), translatedTitle: null },
    ]
    expect(mergeHits(local, remote).map((h) => h.article.id)).toEqual([9, 2, 1])
  })

  test('a query is trimmed, collapsed and capped as the server takes it', () => {
    expect(normalizeQuery('  a   b ')).toBe('a b')
    expect(normalizeQuery(null)).toBe('')
    expect(normalizeQuery('x'.repeat(150))).toHaveLength(100)
  })
})
