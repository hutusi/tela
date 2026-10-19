import { describe, expect, test } from 'bun:test'
import { MAX_BLOGROLL_BLOGS, MAX_BLOGROLLS, MAX_FOLDERS } from '@tela/shared'
import {
  applyMutation,
  applyPull,
  blogrollPublicChange,
  blogrollPublicUnsettled,
  type Confirmed,
  emptyTables,
  mergeTitles,
  nextTitleIds,
  type Pending,
  privacyChange,
  privacyUnsettled,
  pruneTitlesTo,
  readingLangOf,
  rowsOf,
  settle,
  type Tables,
  titlesIn,
  view,
} from './client'
import type { Mutation } from './mutations'
import { emptyRows, type PullResponse } from './protocol'
import type {
  ArticleRow,
  BlogrollBlogRow,
  BlogrollRow,
  FollowRow,
  ProfileRow,
  StateRow,
  SubscriptionRow,
  TitleRow,
} from './rows'

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

  test('a later read moves the clock of a read post, so an unread made between loses', () => {
    // As the server decides (Codex review): marked unread at 6, read at 8 and at 12, in either
    // order, then an unread from 10.
    for (const reads of [
      [8, 12],
      [12, 8],
    ]) {
      const shown = view(held, [unread(7, 6), ...reads.map((at) => read(7, at)), unread(7, 10)])
      expect(shown.states.get(7)).toMatchObject({ readAt: reads[0], readUpdatedAt: 12 })
    }
    // Read at 5 and never marked: a second device's read at 9 moves the clock, not the time.
    expect(view(held, [read(7, 9), unread(7, 7)]).states.get(7)).toMatchObject({
      readAt: 5,
      readUpdatedAt: 9,
    })
    const older = view(held, [read(7, 4)]).states.get(7)
    expect([older?.readAt, older?.readUpdatedAt ?? null]).toEqual([5, null]) // older: nothing moves
    // Mark all read moves the clock of one read by hand.
    const all = view(held, [
      unread(7, 6),
      read(7, 7),
      m(11, { type: 'markAllRead', feedId: 1, upTo: 8 }),
      unread(7, 9),
    ])
    expect(all.states.get(7)).toMatchObject({ readAt: 7, readUpdatedAt: 11 })
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

describe('folders on the device (ADR 0048)', () => {
  let n = 0
  const m = (at: number, change: Record<string, unknown>) =>
    ({ mutation: { mid: `fold-${++n}-pad`, at, ...change } as Mutation }) satisfies Pending
  const put = (at: number, id: string, name: string) => m(at, { type: 'putFolder', id, name })
  const file = (at: number, feedId: number, folderId: string | null) =>
    m(at, { type: 'fileFeed', feedId, folderId })
  const folderRow = (id: string, name: string, at = 1) => ({
    id,
    name,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    seq: 2,
  })
  const held = applyPull(
    start,
    pull(3, {
      subscriptions: [sub(1), sub(2)],
      folders: [folderRow('folder-a', 'A')],
      feedFolders: [{ feedId: 1, folderId: 'folder-a', updatedAt: 1, seq: 3 }],
    }),
  )

  test('a folder and a move show at once, and the later of each wins', () => {
    const shown = view(held, [
      put(10, 'folder-b', '  B  '),
      put(12, 'folder-a', 'Renamed'),
      put(11, 'folder-a', 'Older, from a slow device'),
      file(10, 2, 'folder-b'),
      file(12, 1, 'folder-b'),
      file(11, 1, null),
    ])
    expect(shown.folders.get('folder-b')).toMatchObject({ name: 'B', createdAt: 10 })
    expect(shown.folders.get('folder-a')?.name).toBe('Renamed')
    expect(shown.feedFolders.get(2)?.folderId).toBe('folder-b')
    expect(shown.feedFolders.get(1)?.folderId).toBe('folder-b')
  })

  test('deleting a folder leaves its blogs in none, and nothing files into it after', () => {
    const shown = view(held, [
      m(10, { type: 'deleteFolder', id: 'folder-a' }),
      file(11, 2, 'folder-a'),
    ])
    expect(shown.folders.size).toBe(0)
    expect(shown.feedFolders.get(1)).toMatchObject({ folderId: null, updatedAt: 1 })
    expect(shown.feedFolders.has(2)).toBe(false)
  })

  test('a deletion from a pull lets the folder go; a filing to none stays held, with its clock', () => {
    const next = applyPull(
      held,
      pull(5, {
        folders: [{ ...folderRow('folder-a', 'A'), deletedAt: 4, updatedAt: 4, seq: 4 }],
        feedFolders: [{ feedId: 1, folderId: null, updatedAt: 1, seq: 4 }],
      }),
    )
    expect(next.tables.folders.size).toBe(0)
    expect(next.tables.feedFolders.get(1)).toMatchObject({ folderId: null, updatedAt: 1 })
    // An older move predicted over it loses, as it will on the server.
    expect(view(next, [file(0, 1, null)]).feedFolders.get(1)?.updatedAt).toBe(1)
  })

  test('past the limit a new folder is not shown, though a rename is', () => {
    const folders = Array.from({ length: MAX_FOLDERS }, (_, i) => folderRow(`folder-${i}`, `F${i}`))
    const full = applyPull(start, pull(3, { folders }))
    const shown = view(full, [put(5, 'folder-over', 'Over'), put(5, 'folder-0', 'Renamed')])
    expect(shown.folders.size).toBe(MAX_FOLDERS)
    expect(shown.folders.get('folder-0')?.name).toBe('Renamed')
  })

  test('a pull from a tela-api before folders keeps what the device holds', () => {
    const { folders: _f, feedFolders: _ff, ...rows } = emptyRows()
    const old = {
      cursor: 5,
      more: false,
      reset: false,
      rows,
      tombstones: [],
    } as unknown as PullResponse
    const next = applyPull(held, old)
    expect(next.tables.folders.get('folder-a')?.name).toBe('A')
    expect(next.tables.feedFolders.get(1)?.folderId).toBe('folder-a')
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

  test('a show names the confirmed version, and waits while a change to its switch is on its way (#16)', () => {
    const held = applyPull(start, pull(4, { profile: [{ ...profile, publicLikesVersion: 3 }] }))
    let confirmed = held
    const pending: Pending[] = []
    const press = (on: boolean, at: number) => {
      const input = privacyChange(confirmed, pending, 'publicLikes', on)
      if (input) pending.push({ mutation: { ...input, mid: `likes-${at}-pad`, at } as Mutation })
      return input
    }
    expect(privacyUnsettled(confirmed, pending, 'publicLikes')).toBe(false)
    expect(press(true, 10)).toEqual({
      type: 'setPrivacy',
      publicLikes: true,
      base: { publicLikes: 3 },
    })
    // A hide never waits; the show after it does, and the other switch is not held back.
    expect(press(false, 11)).toEqual({ type: 'setPrivacy', publicLikes: false })
    expect(press(true, 12)).toBeNull()
    expect(privacyUnsettled(confirmed, pending, 'publicLikes')).toBe(true)
    expect(privacyUnsettled(confirmed, pending, 'publicSubscriptions')).toBe(false)
    // Nothing on the device counts versions: the view's is the confirmed one.
    expect(view(confirmed, pending).profile).toMatchObject({
      publicLikes: false,
      publicLikesVersion: 3,
    })
    // Acknowledged, and not yet pulled: still waiting.
    for (const p of pending) p.ackedAt = 6
    expect(privacyUnsettled(confirmed, pending, 'publicLikes')).toBe(true)
    // The pull that reaches the acknowledgement brings the version the server counted.
    confirmed = applyPull(
      confirmed,
      pull(6, { profile: [{ ...profile, publicLikes: false, publicLikesVersion: 5, seq: 6 }] }),
    )
    const settled = settle(confirmed, pending)
    expect(settled).toEqual([])
    pending.length = 0
    expect(press(true, 13)).toMatchObject({ base: { publicLikes: 5 } })
  })

  test('a show waits until a row has come, since no version is known before it', () => {
    expect(privacyUnsettled(start, [], 'publicLikes')).toBe(true)
    expect(privacyChange(start, [], 'publicLikes', true)).toBeNull()
    expect(privacyChange(start, [], 'publicLikes', false)).toEqual({
      type: 'setPrivacy',
      publicLikes: false,
    })
  })

  test('replayed over a pull that already holds it, a change counts nothing twice', () => {
    const held = applyPull(start, pull(4, { profile: [{ ...profile, publicLikesVersion: 1 }] }))
    // A hide whose answer was lost, and a pull that holds it.
    const hide: Pending = {
      mutation: { mid: 'hide-likes-pad', at: 20, type: 'setPrivacy', publicLikes: false },
    }
    const pulled = applyPull(
      held,
      pull(5, { profile: [{ ...profile, publicLikes: false, publicLikesVersion: 2, seq: 5 }] }),
    )
    expect(view(pulled, [hide]).profile).toMatchObject({
      publicLikes: false,
      publicLikesVersion: 2,
    })
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

describe("adopting a visitor's language or theme on the device", () => {
  const profile: ProfileRow = {
    handle: 'me',
    displayName: null,
    bio: null,
    uiLocale: null,
    readingLang: null,
    publicSubscriptions: false,
    publicLikes: false,
    gravatar: false,
    gravatarFound: null,
    avatarUploaded: false,
    avatar: null,
    seq: 1,
  }
  const adopt = (uiLocale: 'fr' | 'en', at: number): Pending => ({
    mutation: { mid: `adopt-${uiLocale}-${at}`, at, type: 'setProfile', uiLocale, adopt: true },
  })

  test('a language fills only an account that has none, and leaves its clock', () => {
    const blank = applyPull(start, pull(4, { profile: [profile] }))
    expect(view(blank, [adopt('fr', 50)]).profile).toMatchObject({ uiLocale: 'fr', uiLocaleAt: 0 })
    const chosen = applyPull(
      start,
      pull(4, { profile: [{ ...profile, uiLocale: 'en', uiLocaleAt: 20 }] }),
    )
    expect(view(chosen, [adopt('fr', 50)]).profile).toMatchObject({
      uiLocale: 'en',
      uiLocaleAt: 20,
    })
    // A choice after an adoption wins, whatever its clock.
    const choice: Pending = {
      mutation: { mid: 'choose-en-pad', at: 10, type: 'setProfile', uiLocale: 'en' },
    }
    expect(view(blank, [adopt('fr', 50), choice]).profile).toMatchObject({ uiLocale: 'en' })
  })

  test('a theme fills only a pref no row is held for, with no clock', () => {
    const theme = (value: string, at: number, ifAbsent?: boolean): Pending => ({
      mutation: {
        mid: `theme-${value}-${at}`,
        at,
        type: 'setPref',
        key: 'ui.theme',
        value,
        ...(ifAbsent ? { ifAbsent } : {}),
      },
    })
    expect(view(start, [theme('dark', 50, true)]).prefs.get('ui.theme')).toMatchObject({
      value: 'dark',
      updatedAt: 0,
    })
    const held = applyPull(
      start,
      pull(4, { prefs: [{ key: 'ui.theme', value: 'light', updatedAt: 20, seq: 4 }] }),
    )
    expect(view(held, [theme('dark', 50, true)]).prefs.get('ui.theme')?.value).toBe('light')
    expect(
      view(start, [theme('dark', 50, true), theme('light', 10)]).prefs.get('ui.theme'),
    ).toMatchObject({ value: 'light', updatedAt: 10 })
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

describe('blogrolls on the device (ADR 0050)', () => {
  const ID = 'RollAAAAAAAA'
  const OTHER = 'RollBBBBBBBB'
  let n = 0
  const m = (at: number, change: Record<string, unknown>) =>
    ({ mutation: { mid: `roll-${++n}-pad`, at, ...change } as Mutation }) satisfies Pending
  const put = (at: number, id: string, name: string, isPublic = false, description = '') =>
    m(at, { type: 'putBlogroll', id, name, description, isPublic })
  const roll = (at: number, feedId: number, blogrollId = ID) =>
    m(at, { type: 'rollBlog', blogrollId, feedId })
  const unroll = (at: number, feedId: number, blogrollId = ID) =>
    m(at, { type: 'unrollBlog', blogrollId, feedId })
  const note = (at: number, feedId: number, text: string | null, blogrollId = ID) =>
    m(at, { type: 'noteBlog', blogrollId, feedId, note: text })
  const blogrollRow = (id: string, over: Partial<BlogrollRow> = {}): BlogrollRow => ({
    id,
    name: 'Friends',
    description: '',
    isPublic: false,
    publicVersion: 0,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    seq: 2,
    ...over,
  })
  const blogRow = (
    feedId: number,
    over: Partial<BlogrollBlogRow> = {},
    blogrollId = ID,
  ): BlogrollBlogRow => ({
    blogrollId,
    feedId,
    note: null,
    noteAt: 0,
    addedAt: 1,
    updatedAt: 1,
    removedAt: null,
    seq: 2,
    ...over,
  })
  const held = applyPull(
    start,
    pull(3, {
      blogrolls: [blogrollRow(ID), blogrollRow(OTHER)],
      blogrollBlogs: [
        blogRow(1, { note: 'kept', noteAt: 1 }),
        blogRow(2, { removedAt: 1, note: 'taken out', noteAt: 1 }),
        blogRow(1, {}, OTHER),
      ],
    }),
  )
  const blog = (t: Tables, feedId: number, blogrollId = ID) =>
    t.blogrollBlogs.get(`${blogrollId}:${feedId}`)

  test('a blogroll shows at once; the later edit wins, and public or private counts only when made', () => {
    const shown = view(start, [
      put(10, 'RollNEWNEWNE', '  New  ', true, '  A line.\nAnother.  '),
      put(12, ID, 'Renamed'),
      put(11, 'RollNEWNEWNE', 'Older, from a slow device'),
      put(13, 'RollNEWNEWNE', 'Later', false),
    ])
    expect(shown.blogrolls.get('RollNEWNEWNE')).toMatchObject({
      name: 'Later',
      description: '',
      isPublic: true, // made public; a later edit's `isPublic` is not a switch
      publicVersion: 0,
      createdAt: 10,
      updatedAt: 13,
    })
    expect(
      view(start, [
        put(10, 'RollNEWNEWNE', '  New  ', true, '  A line.\nAnother.  '),
      ]).blogrolls.get('RollNEWNEWNE'),
    ).toMatchObject({ name: 'New', description: 'A line.\nAnother.' })
    expect(view(held, [put(0, ID, 'Older')]).blogrolls.get(ID)?.name).toBe('Friends')
    expect(view(held, [put(5, ID, 'Newer', true)]).blogrolls.get(ID)).toMatchObject({
      name: 'Newer',
      isPublic: false,
    })
  })

  test('past the limit a new blogroll is not shown, though an edit is', () => {
    const blogrolls = Array.from({ length: MAX_BLOGROLLS }, (_, i) =>
      blogrollRow(`Roll${String(i).padStart(8, '0')}`),
    )
    const full = applyPull(start, pull(3, { blogrolls }))
    const shown = view(full, [put(5, 'RollOVEROVER', 'Over'), put(5, 'Roll00000000', 'Renamed')])
    expect(shown.blogrolls.size).toBe(MAX_BLOGROLLS)
    expect(shown.blogrolls.get('Roll00000000')?.name).toBe('Renamed')
  })

  test('deleting a blogroll lets it go with its blogs, and nothing goes into it after', () => {
    const gone = view(held, [
      m(10, { type: 'deleteBlogroll', id: ID }),
      roll(11, 3),
      note(11, 1, 'late'),
      unroll(11, 1),
    ])
    expect(gone.blogrolls.has(ID)).toBe(false)
    expect([...gone.blogrollBlogs.keys()]).toEqual([`${OTHER}:1`])
    // A deletion held by another device's pull already: nothing to take.
    const pulled = applyPull(
      held,
      pull(5, { blogrolls: [blogrollRow(ID, { deletedAt: 4, seq: 5 })] }),
    )
    expect(view(pulled, [m(10, { type: 'deleteBlogroll', id: ID })]).blogrolls.size).toBe(1)
  })

  test('a blog put in goes to the end; one in already keeps its place; one put back keeps its note', () => {
    const shown = view(held, [roll(10, 3), roll(11, 1), roll(12, 2)])
    expect(blog(shown, 3)).toMatchObject({
      addedAt: 10,
      updatedAt: 10,
      removedAt: null,
      note: null,
      noteAt: 0,
    })
    expect(blog(shown, 1)).toMatchObject({ addedAt: 1, updatedAt: 11, note: 'kept' })
    expect(blog(shown, 2)).toMatchObject({ addedAt: 12, removedAt: null, note: 'taken out' })
    // Into a blogroll not held: nothing.
    expect(blog(view(held, [roll(10, 3, 'RollNONENONE')]), 3, 'RollNONENONE')).toBeUndefined()
  })

  test('taking out goes to the later `at`, and a second one moves the clock so an older put-back loses', () => {
    expect(blog(view(held, [unroll(0, 1)]), 1)?.removedAt).toBeNull() // older than the put-in
    expect(blog(view(held, [unroll(10, 1)]), 1)).toMatchObject({
      removedAt: 10,
      updatedAt: 10,
      note: 'kept',
    })
    // Taken out again at 20: the first time stays, the clock moves, and a put-back from 15 loses.
    const twice = view(held, [unroll(10, 1), unroll(20, 1), roll(15, 1)])
    expect(blog(twice, 1)).toMatchObject({ removedAt: 10, updatedAt: 20 })
    // An older second one moves nothing.
    expect(blog(view(held, [unroll(10, 1), unroll(5, 1)]), 1)?.updatedAt).toBe(10)
    // No row, no change.
    expect(blog(view(held, [unroll(10, 7)]), 7)).toBeUndefined()
    // In either order, the later of a put-back and a take-out wins.
    expect(blog(view(held, [roll(20, 2), unroll(15, 2)]), 2)?.removedAt).toBeNull()
    const later = blog(view(held, [unroll(25, 2), roll(20, 2)]), 2)
    expect(later).toMatchObject({ updatedAt: 25, removedAt: 1 })
  })

  test('a note goes to the later `at` on its own clock, and never puts a blog back', () => {
    const shown = view(held, [note(10, 1, '  Read this.  '), note(9, 1, 'older')])
    expect(blog(shown, 1)).toMatchObject({ note: 'Read this.', noteAt: 10 })
    expect(blog(view(held, [note(10, 1, '   ')]), 1)).toMatchObject({ note: null, noteAt: 10 })
    expect(blog(view(held, [note(10, 1, null)]), 1)?.note).toBeNull()
    // On a blog taken out: written, and it stays out; put back, it comes with the note.
    expect(blog(view(held, [note(10, 2, 'For later')]), 2)).toMatchObject({
      note: 'For later',
      removedAt: 1,
    })
    expect(blog(view(held, [note(10, 2, 'For later'), roll(11, 2)]), 2)).toMatchObject({
      note: 'For later',
      removedAt: null,
    })
    // A note survives a take-out and a put-back.
    expect(blog(view(held, [unroll(10, 1), roll(11, 1)]), 1)?.note).toBe('kept')
    // No row: no note, and no blog.
    expect(blog(view(held, [note(10, 9, 'nowhere')]), 9)).toBeUndefined()
  })

  test('past the limit a new blog is not put in, though one already in can be', () => {
    const blogrollBlogs = Array.from({ length: MAX_BLOGROLL_BLOGS }, (_, i) => blogRow(100 + i))
    const full = applyPull(
      start,
      pull(3, {
        blogrolls: [blogrollRow(ID)],
        blogrollBlogs: [...blogrollBlogs, blogRow(1, { removedAt: 1 })],
      }),
    )
    const shown = view(full, [roll(5, 1), roll(5, 9999), roll(6, 100)])
    expect(blog(shown, 1)?.removedAt).not.toBeNull()
    expect(blog(shown, 9999)).toBeUndefined()
    expect(blog(shown, 100)?.updatedAt).toBe(6)
    // One taken out opens a place.
    expect(blog(view(full, [unroll(5, 100), roll(6, 1)]), 1)?.removedAt).toBeNull()
  })

  test('a hide always applies; a show only against the version held, and nothing counts versions', () => {
    const versioned = applyPull(
      start,
      pull(3, { blogrolls: [blogrollRow(ID, { publicVersion: 4 })] }),
    )
    const show = (at: number, base: number) =>
      m(at, { type: 'setBlogrollPublic', id: ID, isPublic: true, base })
    const hide = (at: number) =>
      m(at, { type: 'setBlogrollPublic', id: ID, isPublic: false, base: 0 })
    expect(view(versioned, [show(10, 4)]).blogrolls.get(ID)).toMatchObject({
      isPublic: true,
      publicVersion: 4,
      updatedAt: 1, // the clock of the name and description stays
    })
    expect(view(versioned, [show(10, 3)]).blogrolls.get(ID)?.isPublic).toBe(false)
    expect(view(versioned, [show(10, 4), hide(5)]).blogrolls.get(ID)?.isPublic).toBe(false)
    // Of a blogroll not held: nothing.
    expect(view(start, [show(10, 0)]).blogrolls.size).toBe(0)
  })

  test('a show names the confirmed version, and waits while a change to the blogroll is on its way', () => {
    let confirmed = applyPull(
      start,
      pull(4, { blogrolls: [blogrollRow(ID, { publicVersion: 3 })] }),
    )
    const pending: Pending[] = []
    const press = (on: boolean, at: number) => {
      const input = blogrollPublicChange(confirmed, pending, ID, on)
      if (input) pending.push({ mutation: { ...input, mid: `pub-${at}-pad`, at } as Mutation })
      return input
    }
    expect(blogrollPublicUnsettled(confirmed, pending, ID)).toBe(false)
    expect(press(true, 10)).toEqual({ type: 'setBlogrollPublic', id: ID, isPublic: true, base: 3 })
    // A hide never waits; the show after it does.
    expect(press(false, 11)).toEqual({
      type: 'setBlogrollPublic',
      id: ID,
      isPublic: false,
      base: 3,
    })
    expect(press(true, 12)).toBeNull()
    expect(blogrollPublicUnsettled(confirmed, pending, ID)).toBe(true)
    // Acknowledged, not yet pulled: still waiting.
    for (const p of pending) p.ackedAt = 6
    expect(blogrollPublicUnsettled(confirmed, pending, ID)).toBe(true)
    // The pull that reaches the acknowledgement brings the version the server counted.
    confirmed = applyPull(
      confirmed,
      pull(6, { blogrolls: [blogrollRow(ID, { isPublic: false, publicVersion: 5, seq: 6 })] }),
    )
    expect(settle(confirmed, pending)).toEqual([])
    pending.length = 0
    expect(press(true, 13)).toMatchObject({ base: 5 })
    // One made on this device and not pulled back has no version yet: a show waits, a hide goes.
    const made = [put(20, 'RollMADEMADE', 'Made')]
    expect(blogrollPublicUnsettled(confirmed, made, 'RollMADEMADE')).toBe(true)
    expect(blogrollPublicChange(confirmed, made, 'RollMADEMADE', true)).toBeNull()
    expect(blogrollPublicChange(confirmed, made, 'RollMADEMADE', false)).toMatchObject({
      base: 0,
    })
  })

  test('a pull folds blogs before blogrolls, keeps those of a blogroll not held yet, and a deletion takes its blogs', () => {
    // A page can end before the blogroll's own row: its blogs are kept until it comes.
    const early = applyPull(
      start,
      pull(3, { blogrollBlogs: [blogRow(1), blogRow(2, { removedAt: 2 })] }),
    )
    expect(early.tables.blogrolls.size).toBe(0)
    expect([...early.tables.blogrollBlogs.keys()]).toEqual([`${ID}:1`, `${ID}:2`])
    expect(early.tables.blogrollBlogs.get(`${ID}:2`)?.removedAt).toBe(2)
    const whole = applyPull(early, pull(4, { blogrolls: [blogrollRow(ID)] }))
    expect(whole.tables.blogrolls.get(ID)?.name).toBe('Friends')
    expect(whole.tables.blogrollBlogs.size).toBe(2)
    // A deletion, with a blog row changed in the same page: both go.
    const deleted = applyPull(
      held,
      pull(5, {
        blogrolls: [blogrollRow(ID, { deletedAt: 5, updatedAt: 5, seq: 5 })],
        blogrollBlogs: [blogRow(3, { seq: 5 })],
      }),
    )
    expect(deleted.tables.blogrolls.has(ID)).toBe(false)
    expect([...deleted.tables.blogrollBlogs.keys()]).toEqual([`${OTHER}:1`])
  })

  test('a pull from a tela-api before blogrolls keeps what the device holds', () => {
    const { blogrolls: _b, blogrollBlogs: _bb, ...rows } = emptyRows()
    const old = {
      cursor: 5,
      more: false,
      reset: false,
      rows,
      tombstones: [],
    } as unknown as PullResponse
    const next = applyPull(held, old)
    expect(next.tables.blogrolls.size).toBe(2)
    expect(next.tables.blogrollBlogs.size).toBe(3)
  })
})

describe('the view replays a queue on one copy (ADR 0050)', () => {
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
  const profile: ProfileRow = {
    handle: 'me',
    displayName: null,
    bio: null,
    uiLocale: 'en',
    readingLang: null,
    uiLocaleAt: 5,
    readingLangAt: 5,
    publicSubscriptions: false,
    publicLikes: true,
    publicSubscriptionsVersion: 1,
    publicLikesVersion: 2,
    gravatar: true,
    gravatarFound: null,
    avatarUploaded: false,
    avatar: '/avatar/me?v=1',
    seq: 1,
  }
  const FEEDS = [1, 2, 3, 4]
  const ARTICLES = [1, 2, 3, 4, 5, 6, 7, 8]
  const FOLDERS = ['folder-aaaa', 'folder-bbbb', 'folder-cccc']
  const BLOGROLLS = ['RollAAAAAAAA', 'RollBBBBBBBB', 'RollCCCCCCCC']
  const PEOPLE = ['member-anna-0000001', 'member-bo-000000002']
  const confirmed = applyPull(
    start,
    pull(9, {
      profile: [profile],
      subscriptions: [sub(1), sub(2), sub(3, 4)],
      articles: ARTICLES.map((id) => article(id, (id % 4) + 1)),
      states: [
        { ...readState(1, 3), readUpdatedAt: 3 },
        { ...readState(2, 4), likedAt: 4, likedUpdatedAt: 4 },
      ],
      recommendations: [{ articleId: 3, note: null, createdAt: 2, deletedAt: null, seq: 2 }],
      folders: [
        { id: 'folder-aaaa', name: 'A', createdAt: 1, updatedAt: 4, deletedAt: null, seq: 2 },
      ],
      feedFolders: [{ feedId: 1, folderId: 'folder-aaaa', updatedAt: 4, seq: 2 }],
      blogrolls: [
        {
          id: 'RollAAAAAAAA',
          name: 'A',
          description: '',
          isPublic: true,
          publicVersion: 1,
          createdAt: 1,
          updatedAt: 4,
          deletedAt: null,
          seq: 2,
        },
      ],
      blogrollBlogs: [
        {
          blogrollId: 'RollAAAAAAAA',
          feedId: 1,
          note: 'n',
          noteAt: 4,
          addedAt: 1,
          updatedAt: 4,
          removedAt: null,
          seq: 2,
        },
      ],
      prefs: [{ key: 'reader.mode', value: 'side', updatedAt: 4, seq: 2 }],
    }),
  )

  /** Any mutation, over a few ids each, so they meet each other often. */
  function randomMutation(random: () => number, i: number): Mutation {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T
    const mid = `eq-${i}-padding`
    const at = Math.floor(random() * 12)
    const articleId = pick(ARTICLES)
    const feedId = pick(FEEDS)
    const folderId = pick(FOLDERS)
    const blogrollId = pick(BLOGROLLS)
    const userId = pick(PEOPLE)
    const highlight = pick(['hl-000001', 'hl-000002'])
    const options: Mutation[] = [
      { mid, at, type: 'markRead', articleId },
      { mid, at, type: 'markUnread', articleId },
      { mid, at, type: 'setLiked', articleId, liked: random() < 0.5 },
      { mid, at, type: 'markAllRead', upTo: articleId },
      { mid, at, type: 'markAllRead', upTo: articleId, feedId },
      { mid, at, type: 'subscribe', feedId },
      { mid, at, type: 'unsubscribe', feedId },
      { mid, at, type: 'setPref', key: 'reader.mode', value: pick(['side', 'orig']) },
      { mid, at, type: 'setProfile', uiLocale: pick(['en', 'fr']), readingLang: null },
      { mid, at, type: 'setPrivacy', publicLikes: random() < 0.5, base: { publicLikes: 2 } },
      { mid, at, type: 'setAvatar', gravatar: random() < 0.5 },
      { mid, at, type: 'recommend', articleId, note: random() < 0.5 ? ' a note ' : null },
      { mid, at, type: 'unrecommend', articleId },
      { mid, at, type: 'follow', userId },
      { mid, at, type: 'unfollow', userId },
      { mid, at, type: 'putFolder', id: folderId, name: pick(['X', 'Y']) },
      { mid, at, type: 'deleteFolder', id: folderId },
      { mid, at, type: 'fileFeed', feedId, folderId: random() < 0.7 ? folderId : null },
      {
        mid,
        at,
        type: 'putBlogroll',
        id: blogrollId,
        name: pick(['R', 'S']),
        description: '',
        isPublic: random() < 0.5,
      },
      {
        mid,
        at,
        type: 'setBlogrollPublic',
        id: blogrollId,
        isPublic: random() < 0.5,
        base: pick([0, 1]),
      },
      { mid, at, type: 'deleteBlogroll', id: blogrollId },
      { mid, at, type: 'rollBlog', blogrollId, feedId },
      { mid, at, type: 'unrollBlog', blogrollId, feedId },
      { mid, at, type: 'noteBlog', blogrollId, feedId, note: random() < 0.6 ? 'note' : null },
      {
        mid,
        at,
        type: 'putHighlight',
        id: highlight,
        articleId,
        contentKey: 'a'.repeat(32),
        side: 'original',
        lang: null,
        leafId: 'leaf000001',
        start: 0,
        end: 4,
        quote: 'Post',
        prefix: '',
        suffix: '',
        note: null,
      },
      { mid, at, type: 'deleteHighlight', id: highlight },
    ]
    return pick(options)
  }

  test('equals applying each mutation to a copy in turn, and leaves the confirmed tables alone', () => {
    const before = structuredClone(rowsOf(confirmed.tables))
    for (let seed = 1; seed <= 300; seed++) {
      const random = rng(seed)
      const pending: Pending[] = Array.from({ length: Math.floor(random() * 40) }, (_, i) => ({
        mutation: randomMutation(random, i),
      }))
      const folded = pending.reduce((t, p) => applyMutation(t, p.mutation), confirmed.tables)
      expect(rowsOf(view(confirmed, pending))).toEqual(rowsOf(folded))
      expect(rowsOf(confirmed.tables)).toEqual(before)
    }
  })

  test('with nothing pending it is the confirmed tables themselves; with anything, a copy', () => {
    expect(view(confirmed, [])).toBe(confirmed.tables)
    const later = { mid: 'from-a-later-build', at: 5, type: 'somethingNew' } as unknown as Mutation
    const shown = view(confirmed, [{ mutation: later }])
    expect(shown).not.toBe(confirmed.tables)
    expect(shown.articles).not.toBe(confirmed.tables.articles)
    expect(rowsOf(shown)).toEqual(rowsOf(confirmed.tables))
  })
})

describe('titles in the reading language only', () => {
  const title = (articleId: number, lang: string, seq = 1): TitleRow => ({
    articleId,
    lang,
    title: `${lang}:Post ${articleId}`,
    excerpt: null,
    status: 'done',
    seq,
  })
  const titled = (p: PullResponse, titlesLang?: string) =>
    (titlesLang === undefined ? p : { ...p, titlesLang }) as PullResponse
  const held = applyPull(
    start,
    pull(3, {
      subscriptions: [sub(1)],
      articles: [article(7), article(8), { ...article(9), sourceLang: 'fr' }],
    }),
  )

  test("the reading language is the member's choice, else the account's interface, else the page's", () => {
    const profile = (readingLang: string | null, uiLocale: string | null) => ({
      readingLang,
      uiLocale,
    })
    expect(readingLangOf(profile('fr', 'zh-Hans'), 'en')).toBe('fr')
    expect(readingLangOf(profile(null, 'zh-Hant'), 'en')).toBe('zh-Hant')
    expect(readingLangOf(profile(null, null), 'zh-Hans')).toBe('zh-Hans')
    expect(readingLangOf(null, 'fr')).toBe('fr')
    // Anything outside the launch set is no choice at all.
    expect(readingLangOf(profile('ja', 'de'), 'es')).toBe('en')
  })

  test("a pull in the language asked for keeps that language's titles, and says so", () => {
    const p = titled(pull(5, { titles: [title(7, 'fr'), title(8, 'fr')] }), 'fr')
    const { pull: kept, folded } = titlesIn(p, 'fr')
    expect(folded).toBe(true)
    expect(kept).toBe(p)
  })

  test('a tela-api that names no language sends them all: the device keeps its own', () => {
    const p = pull(5, { titles: [title(7, 'fr'), title(7, 'en'), title(8, 'zh-Hans')] })
    const { pull: kept, folded } = titlesIn(p, 'fr')
    expect(folded).toBe(true)
    expect(kept.rows.titles).toEqual([title(7, 'fr')])
    // The pull it came from is left as it was.
    expect(p.rows.titles).toHaveLength(3)
  })

  test("a pull in another language brings none of this one's: its titles go, and it says so", () => {
    const p = titled(pull(5, { titles: [title(7, 'en')], articles: [article(10)] }), 'en')
    const { pull: kept, folded } = titlesIn(p, 'fr')
    expect(folded).toBe(false)
    expect(kept.rows.titles).toEqual([])
    expect(kept.rows.articles.map((a) => a.id)).toEqual([10])
  })

  test('fetched titles fold in by seq, for held articles, in the language asked for only', () => {
    const before = applyPull(held, pull(4, { titles: [title(7, 'fr', 4)] }))
    const merged = mergeTitles(
      before.tables,
      [
        // Older than the one a pull already brought: never put back.
        { ...title(7, 'fr', 2), title: 'older' },
        title(8, 'fr', 3),
        // Another language, and an article the device let go.
        title(8, 'en', 3),
        title(70, 'fr', 3),
      ],
      'fr',
    )
    expect([...merged.titles.keys()].sort()).toEqual(['7:fr', '8:fr'])
    expect(merged.titles.get('7:fr')?.title).toBe('fr:Post 7')
    expect(before.tables.titles.size).toBe(1) // what it was given is untouched
    expect(mergeTitles(before.tables, [title(7, 'fr', 4)], 'fr')).toBe(before.tables)
  })

  test('asks only for held posts missing the language, never one written in it, a page at a time', () => {
    const withOne = mergeTitles(held.tables, [title(7, 'fr')], 'fr')
    // 9 is written in French: no French title is ever made for it.
    expect(nextTitleIds(withOne, 'fr')).toEqual([8])
    expect(nextTitleIds(held.tables, 'en')).toEqual([9])
    expect(nextTitleIds(held.tables, 'zh-Hans')).toEqual([7, 8, 9])
    expect(nextTitleIds(held.tables, 'zh-Hans', 2)).toEqual([7, 8])
    // A pass goes on past the last one asked, whether or not the server had a title for it, so
    // one it never has cannot keep the pass going.
    expect(nextTitleIds(held.tables, 'zh-Hans', 2, 8)).toEqual([9])
    expect(nextTitleIds(held.tables, 'zh-Hans', 2, 9)).toEqual([])
  })

  test('switching lets every other language go', () => {
    const both = applyPull(held, pull(4, { titles: [title(7, 'fr'), title(7, 'en')] }))
    const pruned = pruneTitlesTo(both.tables, 'fr')
    expect([...pruned.titles.keys()]).toEqual(['7:fr'])
    expect(pruned.articles).toBe(both.tables.articles)
    expect(pruneTitlesTo(pruned, 'fr')).toBe(pruned)
  })
})
