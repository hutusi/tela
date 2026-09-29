import { describe, expect, test } from 'bun:test'
import { applyPull, type Confirmed, emptyTables, type Pending, settle, view } from './client'
import { emptyRows, type PullResponse } from './protocol'
import type { ArticleRow, StateRow, SubscriptionRow } from './rows'

const article = (id: number, feedId = 1): ArticleRow => ({
  id,
  feedId,
  url: null,
  title: `Post ${id}`,
  author: null,
  publishedAt: null,
  fetchedAt: 0,
  sortAt: 0,
  sourceLang: 'en',
  excerpt: null,
  contentKey: null,
  wordCount: 0,
  readingMinutes: 1,
  extractState: 'none',
  likeCount: 0,
  recommendCount: 0,
  seq: 1,
})
const sub = (feedId: number, deletedAt: number | null = null): SubscriptionRow => ({
  feedId,
  watermarkId: 0,
  createdAt: 0,
  deletedAt,
  seq: 1,
})
const pull = (
  cursor: number,
  rows: Partial<PullResponse['rows']>,
  reset = false,
): PullResponse => ({
  cursor,
  more: false,
  reset,
  rows: { ...emptyRows(), ...rows },
  tombstones: [],
})
const start: Confirmed = { cursor: 0, tables: emptyTables() }

describe('the device view', () => {
  test('shows a pending like at once, and the count with it', () => {
    const confirmed = applyPull(start, pull(3, { subscriptions: [sub(1)], articles: [article(7)] }))
    const pending: Pending[] = [
      { mutation: { mid: 'like-7-pad', at: 10, type: 'setLiked', articleId: 7, liked: true } },
    ]
    const shown = view(confirmed, pending)
    expect(shown.states.get(7)).toMatchObject({ likedAt: 10, readAt: 10 })
    expect(shown.articles.get(7)?.likeCount).toBe(1)
    expect(confirmed.tables.states.get(7)).toBeUndefined() // confirmed is untouched
  })

  test('keeps an acknowledged mutation until a pull reaches its seq, so nothing flickers', () => {
    const confirmed = applyPull(start, pull(3, { subscriptions: [sub(1)], articles: [article(7)] }))
    const acked: Pending[] = [
      {
        mutation: { mid: 'read-7-pad', at: 10, type: 'markRead', articleId: 7 },
        ackedAt: 5,
      },
    ]
    expect(settle(confirmed, acked)).toHaveLength(1) // cursor 3 has not reached 5
    const reached = applyPull(confirmed, pull(5, { states: [readState(7, 10)] }))
    expect(settle(reached, acked)).toEqual([])
    expect(view(reached, []).states.get(7)?.readAt).toBe(10)
  })

  test('a snapshot replaces everything held', () => {
    const held = applyPull(start, pull(3, { subscriptions: [sub(1)], articles: [article(7)] }))
    const fresh = applyPull(
      held,
      pull(9, { subscriptions: [sub(2)], articles: [article(8, 2)] }, true),
    )
    expect([...fresh.tables.articles.keys()]).toEqual([8])
    expect(fresh.cursor).toBe(9)
  })

  test("unsubscribing lets go of a feed's articles, except the kept ones", () => {
    const held = applyPull(
      start,
      pull(3, {
        subscriptions: [sub(1)],
        articles: [article(7), article(8)],
        states: [{ ...readState(8, 1), likedAt: 2, likedUpdatedAt: 2 }],
      }),
    )
    const left = applyPull(held, pull(4, { subscriptions: [sub(1, 50)] }))
    expect([...left.tables.articles.keys()]).toEqual([8])
    // And a kept article unkept later goes too.
    const unliked = applyPull(
      left,
      pull(5, { states: [{ ...readState(8, 1), likedUpdatedAt: 6 }] }),
    )
    expect([...unliked.tables.articles.keys()]).toEqual([])
  })
})

function readState(articleId: number, readAt: number): StateRow {
  return { articleId, readAt, likedAt: null, likedUpdatedAt: null, seq: 5 }
}
