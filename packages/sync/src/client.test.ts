import { describe, expect, test } from 'bun:test'
import { applyPull, type Confirmed, emptyTables, type Pending, settle, view } from './client'
import { emptyRows, type PullResponse } from './protocol'
import type { ArticleRow, FollowRow, ProfileRow, StateRow, SubscriptionRow } from './rows'

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

describe('highlights on the device', () => {
  const put = (id: string, articleId: number, at: number, note: string | null = null) =>
    ({
      mid: `${id}-${at}-pad`,
      at,
      type: 'putHighlight',
      id,
      articleId,
      contentKey: 'a'.repeat(32),
      side: 'original',
      lang: null,
      leafId: 'leaf000001',
      start: 0,
      end: 4,
      quote: 'Post',
      prefix: '',
      suffix: ' 7',
      note,
    }) as const

  test('show at once, keep the later edit, and go on deletion', () => {
    const confirmed = applyPull(start, pull(3, { subscriptions: [sub(1)], articles: [article(7)] }))
    const shown = view(confirmed, [
      { mutation: put('h-000001', 7, 10, 'first') },
      { mutation: put('h-000001', 7, 5, 'older, from a slow device') },
      { mutation: put('h-000001', 7, 12, '  kept  ') },
    ])
    expect(shown.highlights.get('h-000001')).toMatchObject({
      note: 'kept',
      createdAt: 10,
      updatedAt: 12,
    })
    const gone = view(confirmed, [
      { mutation: put('h-000001', 7, 10) },
      { mutation: { mid: 'del-000001-pad', at: 11, type: 'deleteHighlight', id: 'h-000001' } },
    ])
    expect(gone.highlights.size).toBe(0)
  })

  test('a highlighted article stays after its feed is left; a deleted highlight lets it go', () => {
    const held = applyPull(
      start,
      pull(3, { subscriptions: [sub(1)], articles: [article(7), article(8)] }),
    )
    const highlighted = applyPull(
      held,
      pull(4, {
        highlights: [
          { ...put('h-000002', 7, 1), createdAt: 1, updatedAt: 1, deletedAt: null, seq: 4 },
        ],
      }),
    )
    const left = applyPull(highlighted, pull(5, { subscriptions: [sub(1, 5)] }))
    expect([...left.tables.articles.keys()]).toEqual([7])
    const deleted = applyPull(
      left,
      pull(6, {
        highlights: [
          { ...put('h-000002', 7, 1), createdAt: 1, updatedAt: 6, deletedAt: 6, seq: 6 },
        ],
      }),
    )
    expect(deleted.tables.highlights.size).toBe(0)
    expect(deleted.tables.articles.size).toBe(0)
  })
})

describe('follows and privacy flags on the device (ADR 0031)', () => {
  const ID = 'member-anna-00000001'
  const followRow = (deletedAt: number | null, handle = 'anna', seq = 2): FollowRow => ({
    userId: ID,
    handle,
    displayName: 'Anna',
    createdAt: 5,
    deletedAt,
    seq,
  })
  const profile: ProfileRow = {
    handle: 'me',
    displayName: null,
    bio: null,
    uiLocale: null,
    readingLang: null,
    publicSubscriptions: true,
    publicLikes: false,
    seq: 1,
  }

  test('a follow shows at once, nameless until the pull names it', () => {
    const shown = view(start, [
      { mutation: { mid: 'follow-anna', at: 10, type: 'follow', userId: ID } },
    ])
    expect(shown.follows.get(ID)).toMatchObject({ handle: null, createdAt: 10, deletedAt: null })
    const pulled = applyPull(start, pull(4, { follows: [followRow(null)] }))
    expect(view(pulled, []).follows.get(ID)?.handle).toBe('anna')
  })

  test('an unfollow lets the row go, from a pull or a prediction; a rename replaces it', () => {
    const held = applyPull(start, pull(4, { follows: [followRow(null)] }))
    expect(
      view(held, [{ mutation: { mid: 'unfollow-anna', at: 11, type: 'unfollow', userId: ID } }])
        .follows.size,
    ).toBe(0)
    const renamed = applyPull(held, pull(6, { follows: [followRow(null, 'anna_k', 6)] }))
    expect(renamed.tables.follows.get(ID)?.handle).toBe('anna_k')
    expect(applyPull(renamed, pull(7, { follows: [followRow(7)] })).tables.follows.size).toBe(0)
  })

  test('privacy flags apply, false included', () => {
    const held = applyPull(start, pull(4, { profile: [profile] }))
    const shown = view(held, [
      {
        mutation: {
          mid: 'hide-subs-pad',
          at: 10,
          type: 'setProfile',
          publicSubscriptions: false,
          publicLikes: true,
        },
      },
    ])
    expect(shown.profile).toMatchObject({ publicSubscriptions: false, publicLikes: true })
    const untouched = view(held, [
      { mutation: { mid: 'lang-only-pad', at: 10, type: 'setProfile', readingLang: 'zh-Hans' } },
    ])
    expect(untouched.profile).toMatchObject({ publicSubscriptions: true, readingLang: 'zh-Hans' })
  })
})
