import { describe, expect, test } from 'bun:test'
import {
  applyPull,
  type Confirmed,
  emptyTables,
  type Pending,
  privacyChange,
  settle,
  view,
} from './client'
import type { Mutation } from './mutations'
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

describe('read and unread on the device (ADR 0009)', () => {
  const held = applyPull(
    start,
    pull(3, {
      subscriptions: [sub(1), sub(2)],
      articles: [article(7), article(8), article(9, 2), article(10)],
      states: [readState(7, 5)],
    }),
  )
  let n = 0
  const m = (at: number, change: Record<string, unknown>) =>
    ({ mutation: { mid: `state-${++n}-pad`, at, ...change } as Mutation }) as Pending
  const unread = (articleId: number, at: number) => m(at, { type: 'markUnread', articleId })
  const read = (articleId: number, at: number) => m(at, { type: 'markRead', articleId })

  test('an unread goes to the later `at`; a read after it keeps a clock, a first read none', () => {
    expect(view(held, [unread(7, 4)]).states.get(7)).toMatchObject({ readAt: 5 }) // older
    const marked = view(held, [unread(7, 6)])
    expect(marked.states.get(7)).toMatchObject({ readAt: null, readUpdatedAt: 6 })
    expect(view(held, [unread(7, 6), read(7, 5)]).states.get(7)).toMatchObject({
      readAt: null,
      readUpdatedAt: 6,
    })
    expect(view(held, [unread(7, 6), read(7, 8)]).states.get(7)).toMatchObject({
      readAt: 8,
      readUpdatedAt: 8,
    })
    expect(view(held, [read(8, 3)]).states.get(8)).toMatchObject({ readAt: 3, readUpdatedAt: null })
  })

  test('a like does not read a post marked unread', () => {
    const liked = view(held, [
      unread(8, 2),
      m(3, { type: 'setLiked', articleId: 8, liked: true }),
      m(3, { type: 'setLiked', articleId: 10, liked: true }),
    ])
    expect(liked.states.get(8)).toMatchObject({ readAt: null, likedAt: 3, readUpdatedAt: 2 })
    expect(liked.states.get(10)).toMatchObject({ readAt: 3, likedAt: 3 })
  })

  test('mark all read reads one marked before it, in what it covers, not one marked since', () => {
    const shown = view(held, [
      unread(7, 6),
      unread(8, 9),
      unread(9, 6),
      unread(10, 6),
      m(7, { type: 'markAllRead', feedId: 1, upTo: 8 }),
    ])
    expect(shown.states.get(7)).toMatchObject({ readAt: 7, readUpdatedAt: 7 })
    expect(shown.states.get(8)).toMatchObject({ readAt: null, readUpdatedAt: 9 }) // marked since
    expect(shown.states.get(9)).toMatchObject({ readAt: null }) // another feed
    expect(shown.states.get(10)).toMatchObject({ readAt: null }) // past what was shown
    expect(shown.subscriptions.get(1)?.watermarkId).toBe(8)
  })
})

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
    avatar: null,
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
    gravatar: false,
    gravatarFound: null,
    avatarUploaded: false,
    avatar: null,
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

  test('privacy switches apply, false included', () => {
    const held = applyPull(start, pull(4, { profile: [profile] }))
    const shown = view(held, [
      {
        mutation: {
          mid: 'hide-subs-pad',
          at: 10,
          type: 'setPrivacy',
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

  test("a show names the version it saw; the device's own hide-then-show both apply (#16)", () => {
    const held = applyPull(start, pull(4, { profile: [{ ...profile, publicLikesVersion: 3 }] }))
    // Made one after another, each from the view as the member pressed it.
    const pending: Pending[] = []
    const press = (on: boolean, at: number) => {
      const input = privacyChange(view(held, pending), 'publicLikes', on)
      pending.push({ mutation: { ...input, mid: `likes-${at}-pad`, at } as Mutation })
      return input
    }
    expect(press(true, 10)).toEqual({
      type: 'setPrivacy',
      publicLikes: true,
      base: { publicLikes: 3 },
    })
    expect(press(false, 11)).toEqual({ type: 'setPrivacy', publicLikes: false })
    expect(press(true, 12)).toMatchObject({ base: { publicLikes: 5 } })
    expect(view(held, pending).profile).toMatchObject({ publicLikes: true, publicLikesVersion: 6 })
    // The subscriptions switch is counted apart.
    expect(view(held, pending).profile?.publicSubscriptionsVersion).toBe(0)
  })

  test('a show made against a version a pull has since passed is refused, as the server will', () => {
    const held = applyPull(start, pull(4, { profile: [{ ...profile, publicLikesVersion: 3 }] }))
    const show: Pending = {
      mutation: {
        mid: 'show-likes-pad',
        at: 30,
        type: 'setPrivacy',
        publicLikes: true,
        base: { publicLikes: 3 },
      },
    }
    expect(view(held, [show]).profile).toMatchObject({ publicLikes: true })
    // Another device hid them meanwhile, with an older clock: the pull brings version 4.
    const hidden = applyPull(
      held,
      pull(5, { profile: [{ ...profile, publicLikes: false, publicLikesVersion: 4 }] }),
    )
    expect(view(hidden, [show]).profile).toMatchObject({
      publicLikes: false,
      publicLikesVersion: 4,
    })
    // A show without a base, from a shell before it, applies in order as it always did.
    const { base: _b, ...unbased } = show.mutation as Extract<Mutation, { type: 'setPrivacy' }>
    expect(view(hidden, [{ mutation: unbased }]).profile).toMatchObject({ publicLikes: true })
    // A row from a tela-api without the versions keeps the ones this device holds.
    const { publicLikesVersion: _v, ...bare } = { ...profile, seq: 6 }
    expect(applyPull(hidden, pull(6, { profile: [bare] })).tables.profile).toMatchObject({
      publicLikesVersion: 4,
      publicSubscriptionsVersion: 0,
    })
  })

  test('each language goes to the later choice, and a reading language of null is one', () => {
    const held = applyPull(
      start,
      pull(4, {
        profile: [
          { ...profile, uiLocale: 'en', uiLocaleAt: 20, readingLang: 'fr', readingLangAt: 20 },
        ],
      }),
    )
    // Older than what the account holds: the server will refuse it, so the device does too.
    const older = view(held, [
      { mutation: { mid: 'older-lang-pad', at: 10, type: 'setProfile', uiLocale: 'zh-Hans' } },
    ])
    expect(older.profile).toMatchObject({ uiLocale: 'en', uiLocaleAt: 20 })
    const linked = view(held, [
      { mutation: { mid: 'link-lang-pad', at: 30, type: 'setProfile', readingLang: null } },
    ])
    expect(linked.profile).toMatchObject({ uiLocale: 'en', readingLang: null, readingLangAt: 30 })
    // A row from a tela-api without the clocks keeps the ones this device holds.
    const { uiLocaleAt: _u, readingLangAt: _r, ...bare } = { ...profile, uiLocale: 'en' }
    const again = applyPull(held, pull(5, { profile: [bare] }))
    expect(again.tables.profile).toMatchObject({ uiLocaleAt: 20, readingLangAt: 20 })
  })
})

describe('the Gravatar switch on the device (ADR 0032)', () => {
  const profile: ProfileRow = {
    handle: 'me',
    displayName: null,
    bio: null,
    uiLocale: null,
    readingLang: null,
    publicSubscriptions: false,
    publicLikes: false,
    gravatar: true,
    gravatarFound: null,
    avatarUploaded: false,
    avatar: '/avatar/member-me-0000001?v=5',
    seq: 1,
  }
  const held = applyPull(start, pull(3, { profile: [profile] }))

  test('off takes the picture away at once', () => {
    const off = view(held, [
      { mutation: { mid: 'g-off', at: 10, type: 'setAvatar', gravatar: false } },
    ])
    expect(off.profile).toMatchObject({ gravatar: false, avatar: null })
  })

  test('off leaves an uploaded picture, which comes before any Gravatar (ADR 0033)', () => {
    const uploaded = applyPull(start, pull(4, { profile: [{ ...profile, avatarUploaded: true }] }))
    const off = view(uploaded, [
      { mutation: { mid: 'g-off-2', at: 12, type: 'setAvatar', gravatar: false } },
    ])
    expect(off.profile).toMatchObject({ gravatar: false, avatar: '/avatar/member-me-0000001?v=5' })
  })

  test('on, or Refresh, keeps what it has until the server names the new address', () => {
    const again = view(held, [
      { mutation: { mid: 'g-on', at: 11, type: 'setAvatar', gravatar: true } },
    ])
    expect(again.profile).toMatchObject({ gravatar: true, avatar: '/avatar/member-me-0000001?v=5' })
  })
})

describe('a pull from a tela-api of an earlier release', () => {
  test("reads as having no rows of the tables it does not know, and keeps the device's flags", () => {
    const profile: ProfileRow = {
      handle: 'me',
      displayName: null,
      bio: null,
      uiLocale: null,
      readingLang: null,
      publicSubscriptions: false,
      publicLikes: true,
      gravatar: false,
      gravatarFound: null,
      avatarUploaded: false,
      avatar: null,
      seq: 1,
    }
    const follow: FollowRow = {
      userId: 'member-anna-0000001',
      handle: 'anna',
      displayName: null,
      avatar: null,
      createdAt: 1,
      deletedAt: null,
      seq: 2,
    }
    const pictured = { ...profile, gravatar: true, avatar: '/avatar/member-me-0000001?v=3' }
    const held = applyPull(start, pull(4, { profile: [pictured], follows: [follow] }))
    // What the previous release sends: no `follows`, and a profile without `publicLikes` or the
    // picture's fields.
    const { follows: _f, ...rows } = emptyRows()
    const {
      publicLikes: _p,
      gravatar: _g,
      avatar: _a,
      ...oldProfile
    } = { ...pictured, handle: 'me_renamed', seq: 5 }
    const old = {
      cursor: 5,
      more: false,
      reset: false,
      rows: { ...rows, profile: [oldProfile] },
      tombstones: [],
    } as unknown as PullResponse
    const next = applyPull(held, old)
    expect(next.tables.follows.get(follow.userId)?.handle).toBe('anna')
    expect(next.tables.profile).toMatchObject({
      handle: 'me_renamed',
      publicLikes: true,
      gravatar: true,
      gravatarFound: null,
      avatarUploaded: false,
      avatar: '/avatar/member-me-0000001?v=3',
    })
  })

  test('a change of a type this build does not know changes nothing it shows', () => {
    const held = applyPull(start, pull(3, { subscriptions: [sub(1)], articles: [article(7)] }))
    const later = { mid: 'from-a-later-build', at: 5, type: 'somethingNew' } as unknown as Mutation
    expect(view(held, [{ mutation: later }])).toEqual(held.tables)
  })
})
