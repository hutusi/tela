import { describe, expect, test } from 'bun:test'
import { applyPull, emptyTables, view } from '@tela/sync'
import { hitTitles, mergeHits, normalizeQuery, searchLocal } from '../src/lib/search'
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

  test('newest first means newest published: a first fetch gives the newest post the lowest id', () => {
    const fetched = view(
      applyPull(
        { cursor: 0, tables: emptyTables() },
        pull(
          1,
          {
            subscriptions: [sub(1)],
            articles: [
              article(1, { title: 'Some news', sortAt: 300 }),
              article(2, { title: 'Why pipes sometimes stick', sortAt: 200 }),
              article(3, { title: 'Something older', sortAt: 100 }),
            ],
          },
          true,
        ),
      ),
      [],
    )
    expect(searchLocal(fetched, 'some', 'en').map((h) => h.article.id)).toEqual([1, 2, 3])
  })

  test("adds the server's hits the device did not have, once each, in order", () => {
    const local = searchLocal(t, 'garden', 'en')
    // The server's extra is older than the device's horizon.
    const remote = [
      { article: article(1), translatedTitle: null },
      { article: article(9, { title: 'An old garden', sortAt: -1 }), translatedTitle: null },
    ]
    expect(mergeHits(local, remote).map((h) => h.article.id)).toEqual([2, 1, 9])
  })

  test('a query is trimmed, collapsed and capped as the server takes it', () => {
    expect(normalizeQuery('  a   b ')).toBe('a b')
    expect(normalizeQuery(null)).toBe('')
    expect(normalizeQuery('x'.repeat(150))).toHaveLength(100)
  })
})

describe('how a hit reads', () => {
  const hit = {
    article: article(1, { title: '漁船が早く戻ってきた', sourceLang: 'ja' }),
    translatedTitle: 'The fishing boats came back early',
  }
  test('in the translation, badged, with the original beneath, each line in its language', () => {
    expect(hitTitles(hit, 'boats', 'en', [])).toEqual({
      main: 'The fishing boats came back early',
      mainLang: 'en',
      secondary: '漁船が早く戻ってきた',
      secondaryLang: 'ja',
      badge: true,
    })
  })
  test('as written in a language never translated, with the translation only if that matched', () => {
    expect(hitTitles(hit, '漁船', 'en', ['ja'])).toEqual({
      main: '漁船が早く戻ってきた',
      mainLang: 'ja',
      secondary: null,
      secondaryLang: null,
      badge: false,
    })
    // The line beneath is then the translation, in the reading language.
    expect(hitTitles(hit, 'boats', 'en', ['ja'])).toEqual({
      main: '漁船が早く戻ってきた',
      mainLang: 'ja',
      secondary: 'The fishing boats came back early',
      secondaryLang: 'en',
      badge: false,
    })
  })
  test('a title translated to itself is still in its own language', () => {
    const echo = {
      article: article(4, { title: 'Tokyo', sourceLang: 'ja' }),
      translatedTitle: 'Tokyo',
    }
    expect(hitTitles(echo, 'tokyo', 'en', [])).toMatchObject({
      main: 'Tokyo',
      mainLang: 'ja',
      secondary: null,
    })
  })
  test('untranslated, it reads as written, in its own language or in none it knows', () => {
    const plain = { article: article(2, { title: 'Garden notes', sourceLang: 'en' }) }
    expect(hitTitles({ ...plain, translatedTitle: null }, 'garden', 'fr', [])).toEqual({
      main: 'Garden notes',
      mainLang: 'en',
      secondary: null,
      secondaryLang: null,
      badge: false,
    })
    const unknown = { article: article(3, { title: 'Garden notes', sourceLang: null }) }
    expect(hitTitles({ ...unknown, translatedTitle: null }, 'garden', 'fr', [])).toMatchObject({
      mainLang: null,
      secondary: null,
    })
  })
})
