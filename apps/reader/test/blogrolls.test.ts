/**
 * Blogrolls on the device (ADR 0050): a new one's id and the changes that make it, the limits, the
 * owner's page from the store, Subscribe to all and its Undo, and which changes forget the public
 * copies. Pure: no prediction of a blogroll mutation is needed here (the sync slice writes those),
 * only the folder and subscription predictions that already exist.
 */
import { describe, expect, test } from 'bun:test'
import { BLOGROLL_ID, MAX_BLOGROLL_BLOGS, MAX_BLOGROLLS } from '@tela/shared'
import {
  applyMutation,
  type BlogrollBlogRow,
  type BlogrollRow,
  blogrollBlogKey,
  emptyTables,
  type FeedRow,
  type Mutation,
  type SiteRow,
  type Tables,
} from '@tela/sync'
import {
  blogLabel,
  blogrollAgain,
  blogrollWith,
  blogsCounted,
  canMakeBlogroll,
  knownBlogrolls,
  newBlogrollId,
  subscribeAllPlan,
  undoSubscribeAll,
} from '../src/lib/blogrolls'
import { blogrollSeqs, changedBlogrolls } from '../src/lib/use-forget-blogrolls'
import { myBlogrollCards, selectBlogrollPage } from '../src/store/blogrolls'
import type { MutationInput } from '../src/store/local'
import { folderIdOf } from '../src/store/selectors'
import { updatedWhen } from '../src/views/blogroll'
import type { Person } from '../src/views/types'
import { sub } from './rows'

const ID = 'Abc123def456'

const blogroll = (over: Partial<BlogrollRow> = {}): BlogrollRow => ({
  id: ID,
  name: 'Cities, on foot',
  description: 'Blogs by people who walk their cities.',
  isPublic: false,
  publicVersion: 0,
  createdAt: 10,
  updatedAt: 10,
  deletedAt: null,
  seq: 3,
  ...over,
})

const rolled = (feedId: number, over: Partial<BlogrollBlogRow> = {}): BlogrollBlogRow => ({
  blogrollId: ID,
  feedId,
  note: null,
  noteAt: 0,
  addedAt: feedId * 10,
  updatedAt: feedId * 10,
  removedAt: null,
  seq: 3,
  ...over,
})

const feed = (id: number, siteId: number, over: Partial<FeedRow> = {}): FeedRow => ({
  id,
  siteId,
  feedUrl: `https://site${siteId}.example/feed-${id}.xml`,
  title: `Feed ${id}`,
  status: 'active',
  lastFetchedAt: null,
  lastError: null,
  seq: 1,
  ...over,
})

const site = (id: number, over: Partial<SiteRow> = {}): SiteRow => ({
  id,
  homeUrl: `https://www.site${id}.example/`,
  title: `Site ${id}`,
  description: null,
  faviconKey: null,
  primaryLang: 'en',
  listing: 'listed',
  owned: false,
  claimed: false,
  readerCount: 0,
  translationOptOut: false,
  seq: 1,
  ...over,
})

function tablesWith(over: {
  blogrolls?: BlogrollRow[]
  blogs?: BlogrollBlogRow[]
  feeds?: FeedRow[]
  sites?: SiteRow[]
  subscriptions?: ReturnType<typeof sub>[]
  folders?: { id: string; name: string }[]
  filed?: [number, string | null][]
}): Tables {
  const t = emptyTables()
  for (const r of over.blogrolls ?? []) t.blogrolls.set(r.id, r)
  for (const r of over.blogs ?? []) t.blogrollBlogs.set(blogrollBlogKey(r.blogrollId, r.feedId), r)
  for (const r of over.feeds ?? []) t.feeds.set(r.id, r)
  for (const r of over.sites ?? []) t.sites.set(r.id, r)
  for (const r of over.subscriptions ?? []) t.subscriptions.set(r.feedId, r)
  for (const f of over.folders ?? []) {
    t.folders.set(f.id, { ...f, createdAt: 1, updatedAt: 1, deletedAt: null, seq: 1 })
  }
  for (const [feedId, folderId] of over.filed ?? []) {
    t.feedFolders.set(feedId, { feedId, folderId, updatedAt: 1, seq: 1 })
  }
  return t
}

/**
 * Inputs as the store would make them, stamped in order from `from` (an Undo is stamped after the
 * change it undoes), applied by the device's predictions.
 */
function applied(t: Tables, inputs: readonly MutationInput[], from = 1000): Tables {
  return inputs.reduce(
    (acc, input, i) => applyMutation(acc, { ...input, mid: `m${i}`, at: from + i } as Mutation),
    t,
  )
}

describe("a new blogroll's id", () => {
  test('is twelve letters and digits, as tela-api and the edge route take it', () => {
    for (let i = 0; i < 200; i++) expect(newBlogrollId()).toMatch(BLOGROLL_ID)
  })

  test('skips bytes that would favour the first characters, and is never all digits', () => {
    // First 248..255 (skipped), then digits only (rejected as a whole), then letters.
    const draws = [
      Array.from({ length: 16 }, () => 250),
      Array.from({ length: 16 }, () => 52), // '0'
      Array.from({ length: 16 }, (_, i) => i), // 'A'…
    ]
    let n = 0
    const id = newBlogrollId(() => draws[Math.min(n++, draws.length - 1)] ?? [])
    expect(id).toBe('ABCDEFGHIJKL')
    expect(n).toBe(3)
  })
})

describe('making a blogroll', () => {
  test('one change: made, then each blog in order, once, up to the limit', () => {
    const feedIds = [3, 1, 3, ...Array.from({ length: 250 }, (_, i) => 100 + i)]
    const inputs = blogrollWith({
      id: ID,
      name: 'Cities',
      description: '',
      isPublic: true,
      feedIds,
    })
    expect(inputs[0]).toEqual({
      type: 'putBlogroll',
      id: ID,
      name: 'Cities',
      description: '',
      isPublic: true,
    })
    const rolls = inputs.slice(1)
    expect(rolls).toHaveLength(MAX_BLOGROLL_BLOGS)
    expect(rolls.slice(0, 3)).toEqual([
      { type: 'rollBlog', blogrollId: ID, feedId: 3 },
      { type: 'rollBlog', blogrollId: ID, feedId: 1 },
      { type: 'rollBlog', blogrollId: ID, feedId: 100 },
    ])
  })

  test('made again after its deletion went out: a new id, its blogs in order, notes, and public', () => {
    const inputs = blogrollAgain(
      { name: 'Cities', description: 'On foot', isPublic: true },
      [rolled(2, { note: 'Every Sunday.' }), rolled(5), rolled(7, { note: '' })],
      'Zzz999yyy888',
    )
    expect(inputs).toEqual([
      {
        type: 'putBlogroll',
        id: 'Zzz999yyy888',
        name: 'Cities',
        description: 'On foot',
        isPublic: true,
      },
      { type: 'rollBlog', blogrollId: 'Zzz999yyy888', feedId: 2 },
      { type: 'rollBlog', blogrollId: 'Zzz999yyy888', feedId: 5 },
      { type: 'rollBlog', blogrollId: 'Zzz999yyy888', feedId: 7 },
      { type: 'noteBlog', blogrollId: 'Zzz999yyy888', feedId: 2, note: 'Every Sunday.' },
    ])
  })
})

describe('the limits', () => {
  test('a blogroll whose deletion is held still counts', () => {
    const shown = tablesWith({ blogrolls: [blogroll({ id: 'a00000000001' })] })
    const before = tablesWith({
      blogrolls: [blogroll({ id: 'a00000000001' }), blogroll({ id: 'b00000000002' })],
    })
    expect(knownBlogrolls(shown, before).sort()).toEqual(['a00000000001', 'b00000000002'])
    const full = tablesWith({
      blogrolls: Array.from({ length: MAX_BLOGROLLS }, (_, i) =>
        blogroll({ id: `x${String(i).padStart(11, '0')}` }),
      ),
    })
    expect(canMakeBlogroll(knownBlogrolls(full, full))).toBe(false)
    expect(canMakeBlogroll(knownBlogrolls(shown, before))).toBe(true)
  })

  test("a blog whose removal is held keeps its place, and another blogroll's blogs do not count", () => {
    const shown = tablesWith({
      blogs: [rolled(1), rolled(2, { removedAt: 50 }), rolled(9, { blogrollId: 'other0000000' })],
    })
    const before = tablesWith({ blogs: [rolled(1), rolled(2)] })
    expect(blogsCounted(shown, before, ID)).toBe(2)
    expect(blogsCounted(shown, shown, ID)).toBe(1)
  })
})

describe("the owner's page, from the store", () => {
  const owner: Person = { id: 'u1', handle: 'ana', displayName: 'Ana', avatar: null }
  const t = tablesWith({
    blogrolls: [blogroll({ updatedAt: 10 })],
    blogs: [
      rolled(3, { note: 'Slow and good.', noteAt: 90 }),
      rolled(1),
      rolled(4, { removedAt: 70, updatedAt: 70 }),
      rolled(5),
      rolled(6),
    ],
    // 5 and 6 are two feeds of one blog, so each goes by its feed's own title.
    feeds: [
      feed(1, 11),
      feed(3, 13),
      feed(5, 15, { title: 'Notes' }),
      feed(6, 15, { title: null }),
    ],
    sites: [
      site(11, { readerCount: 7, description: 'A city on foot.' }),
      site(13, { listing: 'rejected' }),
      site(15, { listing: 'private', title: 'Fifteen' }),
    ],
    subscriptions: [sub(1), sub(3, { deletedAt: 40 })],
  })

  test('its blogs in the order put in, removed ones left out, named as tela-api names them', () => {
    const page = selectBlogrollPage(t, ID, owner)
    if (!page) throw new Error('no page')
    expect(page.data.blogroll).toEqual({
      id: ID,
      name: 'Cities, on foot',
      description: 'Blogs by people who walk their cities.',
      updatedAt: 90,
    })
    expect(page.data.owner).toBe(owner)
    expect(page.data.blogs.map((b) => [b.feedId, b.name])).toEqual([
      [1, 'Site 11'],
      [3, 'Site 13'],
      [5, 'Notes'],
      [6, 'Fifteen'],
    ])
    const [one, three, five] = page.data.blogs
    expect(one).toMatchObject({
      siteId: 11,
      homeUrl: 'https://www.site11.example/',
      listed: true,
      readerCount: 7,
      description: 'A city on foot.',
      dead: false,
      note: null,
    })
    expect(three).toMatchObject({ note: 'Slow and good.', listed: false, readerCount: null })
    expect(five?.listed).toBe(false)
  })

  test('says only to the owner which blogs they left and which the operator hid', () => {
    const page = selectBlogrollPage(t, ID, owner)
    expect(page?.flags.get(1)).toEqual({ notSubscribed: false, hiddenFromOthers: false })
    expect(page?.flags.get(3)).toEqual({ notSubscribed: true, hiddenFromOthers: true })
    expect(page?.flags.get(5)).toEqual({ notSubscribed: true, hiddenFromOthers: false })
  })

  test('a blog whose feed the device does not hold yet has no name, and none is not held', () => {
    const bare = tablesWith({ blogrolls: [blogroll()], blogs: [rolled(8)] })
    const page = selectBlogrollPage(bare, ID, owner)
    expect(page?.data.blogs[0]).toMatchObject({ feedId: 8, siteId: 0, name: null, homeUrl: '' })
    expect(selectBlogrollPage(bare, 'Nope00000000', owner)).toBeNull()
  })

  test('the same answer for the same tables, so the page is not redrawn for nothing', () => {
    expect(selectBlogrollPage(t, ID, owner)).toBe(selectBlogrollPage(t, ID, { ...owner }))
  })

  test("as cards on the member's profile, newest first, counting every blog in it", () => {
    const two = tablesWith({
      blogrolls: [blogroll(), blogroll({ id: 'Newer0000000', createdAt: 20, name: 'Newer' })],
      blogs: [rolled(1), rolled(3)],
      feeds: [feed(1, 11), feed(3, 13)],
      sites: [site(11), site(13, { listing: 'rejected' })],
    })
    const cards = myBlogrollCards(two, owner)
    expect(cards.map((c) => [c.id, c.blogCount])).toEqual([
      ['Newer0000000', 0],
      [ID, 2],
    ])
  })
})

describe('Subscribe to all', () => {
  const ids = [1, 2, 3, 4]
  // 1 is followed; 3 was followed once and is still filed in Tech; 4 was never followed.
  const t = tablesWith({
    subscriptions: [sub(1), sub(3, { deletedAt: 5 })],
    folders: [
      { id: 'f-tech', name: 'Tech' },
      { id: 'f-cities', name: 'Cities' },
    ],
    filed: [
      [1, 'f-cities'],
      [3, 'f-tech'],
    ],
  })

  test('into a new folder: subscribes to the blogs not followed, makes it, and files only them', () => {
    const plan = subscribeAllPlan(t, ids, { kind: 'new', id: 'f-new', name: 'Cities, on foot' })
    expect(plan.fresh).toEqual([2, 3, 4])
    expect(plan.inputs).toEqual([
      { type: 'subscribe', feedId: 2, exact: true },
      { type: 'subscribe', feedId: 3, exact: true },
      { type: 'subscribe', feedId: 4, exact: true },
      { type: 'putFolder', id: 'f-new', name: 'Cities, on foot' },
      { type: 'fileFeed', feedId: 2, folderId: 'f-new', exact: true },
      { type: 'fileFeed', feedId: 3, folderId: 'f-new', exact: true },
      { type: 'fileFeed', feedId: 4, folderId: 'f-new', exact: true },
    ])
    expect(plan.made).toBe('f-new')
    const after = applied(t, plan.inputs)
    expect([1, 2, 3, 4].map((id) => folderIdOf(after, id))).toEqual([
      'f-cities',
      'f-new',
      'f-new',
      'f-new',
    ])
    expect([...after.subscriptions.values()].filter((s) => s.deletedAt === null)).toHaveLength(4)
  })

  test('into a folder of theirs: those already there are not filed again', () => {
    const plan = subscribeAllPlan(t, ids, { kind: 'folder', id: 'f-tech' })
    expect(plan.inputs.filter((m) => m.type === 'fileFeed')).toEqual([
      { type: 'fileFeed', feedId: 2, folderId: 'f-tech', exact: true },
      { type: 'fileFeed', feedId: 4, folderId: 'f-tech', exact: true },
    ])
    expect(plan.inputs.some((m) => m.type === 'putFolder')).toBe(false)
  })

  test('into no folder: a blog followed once does not go back to its old folder', () => {
    const plan = subscribeAllPlan(t, ids, { kind: 'none' })
    expect(plan.inputs.filter((m) => m.type === 'fileFeed')).toEqual([
      { type: 'fileFeed', feedId: 3, folderId: null, exact: true },
    ])
    const after = applied(t, plan.inputs)
    expect(folderIdOf(after, 3)).toBeNull()
    expect(folderIdOf(after, 1)).toBe('f-cities')
  })

  test('a folder chosen that has gone since is no folder', () => {
    const plan = subscribeAllPlan(t, [4], { kind: 'folder', id: 'f-gone' })
    expect(plan.inputs).toEqual([{ type: 'subscribe', feedId: 4, exact: true }])
  })

  test('nothing to add makes nothing, not even the folder', () => {
    const plan = subscribeAllPlan(t, [1, 1], { kind: 'new', id: 'f-new', name: 'X' })
    expect(plan).toEqual({ fresh: [], inputs: [], from: [], made: null })
  })

  test('undone after it went out: unsubscribed, filed back, and the folder it made deleted', () => {
    const plan = subscribeAllPlan(t, ids, { kind: 'new', id: 'f-new', name: 'Cities, on foot' })
    const undo = undoSubscribeAll(plan, applied(t, plan.inputs))
    expect(undo).toEqual([
      { type: 'unsubscribe', feedId: 2, exact: true },
      { type: 'unsubscribe', feedId: 3, exact: true },
      { type: 'unsubscribe', feedId: 4, exact: true },
      { type: 'fileFeed', feedId: 3, folderId: 'f-tech', exact: true },
      { type: 'deleteFolder', id: 'f-new' },
    ])
    const back = applied(applied(t, plan.inputs), undo, 2000)
    expect([...back.subscriptions.values()].filter((s) => s.deletedAt === null)).toHaveLength(1)
    expect(back.folders.has('f-new')).toBe(false)
    expect([1, 3].map((id) => folderIdOf(back, id))).toEqual(['f-cities', 'f-tech'])
  })

  test('undone into a folder of theirs: each back where it was, or none if that has gone', () => {
    const plan = subscribeAllPlan(t, ids, { kind: 'none' })
    const later = tablesWith({ folders: [{ id: 'f-cities', name: 'Cities' }] })
    expect(undoSubscribeAll(plan, later)).toEqual([
      { type: 'unsubscribe', feedId: 2, exact: true },
      { type: 'unsubscribe', feedId: 3, exact: true },
      { type: 'unsubscribe', feedId: 4, exact: true },
      // Tech was deleted meanwhile.
      { type: 'fileFeed', feedId: 3, folderId: null, exact: true },
    ])
    const into = subscribeAllPlan(t, ids, { kind: 'folder', id: 'f-cities' })
    expect(undoSubscribeAll(into, t).filter((m) => m.type === 'fileFeed')).toEqual([
      { type: 'fileFeed', feedId: 2, folderId: null, exact: true },
      { type: 'fileFeed', feedId: 3, folderId: 'f-tech', exact: true },
      { type: 'fileFeed', feedId: 4, folderId: null, exact: true },
    ])
  })

  test('a blog is named as a sentence names it: its name, else its host', () => {
    expect(blogLabel({ name: 'Kerb', homeUrl: 'https://kerb.example/' })).toBe('Kerb')
    expect(blogLabel({ name: null, homeUrl: 'https://www.kerb.example/' })).toBe('kerb.example')
    // A blog by path is told apart from the host's other blogs by its path (ADR 0069).
    expect(blogLabel({ name: null, homeUrl: 'https://world.hey.com/kerb' })).toBe(
      'world.hey.com/kerb',
    )
  })
})

describe('forgetting the public copies', () => {
  test("each blogroll's newest sequence number, its blogs' included", () => {
    const t = tablesWith({
      blogrolls: [blogroll({ seq: 4 }), blogroll({ id: 'Other0000000', seq: 2 })],
      blogs: [rolled(1, { seq: 9 }), rolled(2, { seq: 3, removedAt: 5 })],
    })
    expect(blogrollSeqs(t)).toEqual(
      new Map([
        [ID, 9],
        ['Other0000000', 2],
      ]),
    )
  })

  test('a number that moved, a blogroll that came and one that went', () => {
    const before = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ])
    const after = new Map([
      ['a', 1],
      ['b', 5],
      ['d', 1],
    ])
    expect(changedBlogrolls(before, after)).toEqual({ moved: ['b', 'd'], gone: ['c'] })
    expect(changedBlogrolls(after, after)).toEqual({ moved: [], gone: [] })
  })
})

describe('when a blogroll was updated', () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()
  const now = at(2026, 10, 18, 9)

  test('today and yesterday in words, by the calendar here', () => {
    expect(updatedWhen(at(2026, 10, 18, 1), 'en', now)).toEqual({ day: true, when: 'today' })
    expect(updatedWhen(at(2026, 10, 17, 23), 'fr', now)).toEqual({ day: true, when: 'hier' })
    // A clock ahead of this one is today.
    expect(updatedWhen(now + 3_600_000, 'en', now).when).toBe('today')
  })

  test('else the date, with the year once it is not this one', () => {
    expect(updatedWhen(at(2026, 9, 27), 'en', now)).toEqual({ day: false, when: 'Sep 27' })
    expect(updatedWhen(at(2025, 9, 27), 'en', now).when).toBe('Sep 27, 2025')
  })
})
