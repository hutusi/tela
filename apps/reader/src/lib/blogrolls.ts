/**
 * Blogrolls on the device (ADR 0050): a new one's id and the changes that make it, how many there
 * are against the limits, and Subscribe to all, with what its Undo sends once the change has gone.
 * Pure, over the device's tables, so the page and its tests agree.
 */
import { MAX_BLOGROLL_BLOGS, MAX_BLOGROLLS } from '@tela/shared'
import type { BlogrollBlogRow, BlogrollRow, Tables } from '@tela/sync'
import type { MutationInput } from '../store/local'
import { displayHost } from './format'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** 62 × 4: a byte from here up would favour the alphabet's first characters, so it is skipped. */
const FAIR = 248

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count)
  crypto.getRandomValues(bytes)
  return bytes
}

/**
 * A new blogroll's id: twelve letters and digits (`BLOGROLL_ID`), drawn from the platform's
 * random source without bias, and never all digits, so an address never reads as a number.
 */
export function newBlogrollId(random: (count: number) => ArrayLike<number> = randomBytes): string {
  for (;;) {
    let id = ''
    while (id.length < 12) {
      for (const byte of Array.from(random(16))) {
        if (byte < FAIR && id.length < 12) id += ALPHABET[byte % 62]
      }
    }
    if (/[A-Za-z]/.test(id)) return id
  }
}

/** Each id once, in the order first given. */
const unique = (ids: readonly number[]) => [...new Set(ids)]

/**
 * A new blogroll as one change: made, then its blogs put in, in the order given (each is stamped
 * later than the one before, and the server lists them by when they were put in). Past
 * `MAX_BLOGROLL_BLOGS` the rest are left out, as the server would leave them.
 */
export function blogrollWith(b: {
  id: string
  name: string
  description: string
  isPublic: boolean
  feedIds: readonly number[]
}): MutationInput[] {
  return [
    {
      type: 'putBlogroll',
      id: b.id,
      name: b.name,
      description: b.description,
      isPublic: b.isPublic,
    },
    ...unique(b.feedIds)
      .slice(0, MAX_BLOGROLL_BLOGS)
      .map((feedId) => ({ type: 'rollBlog', blogrollId: b.id, feedId }) as const),
  ]
}

/**
 * Undo a deletion after it went to the server: the blogroll made again under a new id, since a
 * deleted one stays deleted, with its blogs in their order and their notes. Public as it was:
 * `isPublic` counts when a blogroll is made, and this makes one.
 */
export function blogrollAgain(
  row: Pick<BlogrollRow, 'name' | 'description' | 'isPublic'>,
  blogs: readonly Pick<BlogrollBlogRow, 'feedId' | 'note'>[],
  id: string = newBlogrollId(),
): MutationInput[] {
  const kept = blogs.slice(0, MAX_BLOGROLL_BLOGS)
  return [
    ...blogrollWith({ id, ...row, feedIds: kept.map((b) => b.feedId) }),
    ...kept
      .filter((b) => b.note !== null && b.note !== '')
      .map((b) => ({ type: 'noteBlog', blogrollId: id, feedId: b.feedId, note: b.note }) as const),
  ]
}

/**
 * The blogrolls the limit reckons with: those shown, and those there would be were every held
 * change taken back (`tablesBeforeHolds`), so one whose deletion is held while its Undo shows
 * keeps its place until the deletion goes (ADR 0048's lesson for folders). By id.
 */
export function knownBlogrolls(
  shown: Pick<Tables, 'blogrolls'>,
  beforeHolds: Pick<Tables, 'blogrolls'>,
): string[] {
  return [...new Set([...beforeHolds.blogrolls.keys(), ...shown.blogrolls.keys()])]
}

/** Whether another blogroll can be made: the server makes none past `MAX_BLOGROLLS`. */
export const canMakeBlogroll = (known: readonly unknown[]) => known.length < MAX_BLOGROLLS

/**
 * How many places a blogroll's blogs take against `MAX_BLOGROLL_BLOGS`: those in it now, and one
 * whose removal is held, which keeps its place until the removal goes.
 */
export function blogsCounted(
  shown: Pick<Tables, 'blogrollBlogs'>,
  beforeHolds: Pick<Tables, 'blogrollBlogs'>,
  blogrollId: string,
): number {
  const live = new Set<number>()
  for (const t of [shown, beforeHolds]) {
    for (const row of t.blogrollBlogs.values()) {
      if (row.blogrollId === blogrollId && row.removedAt === null) live.add(row.feedId)
    }
  }
  return live.size
}

/** A blog as a sentence names it: its name, else its blog's host. */
export const blogLabel = (blog: { name: string | null; homeUrl: string }) =>
  blog.name ?? displayHost(blog.homeUrl)

/** Whether the member follows a feed now. */
const follows = (t: Pick<Tables, 'subscriptions'>, feedId: number) =>
  t.subscriptions.get(feedId)?.deletedAt === null

/** The live folder a blog is filed in, followed or not, as `folderIdOf` says it; null for none. */
function folderOf(t: Pick<Tables, 'folders' | 'feedFolders'>, feedId: number): string | null {
  const id = t.feedFolders.get(feedId)?.folderId ?? null
  return id !== null && t.folders.has(id) ? id : null
}

/** Where Subscribe to all puts the blogs it adds: a folder it makes, one there is, or none. */
export type Destination =
  | { kind: 'new'; id: string; name: string }
  | { kind: 'folder'; id: string }
  | { kind: 'none' }

export type SubscribeAllPlan = {
  /** The blogs it subscribes to: those of the blogroll the member does not follow, in its order. */
  fresh: number[]
  /** The change: a subscribe for each, the folder it makes, then each filed. Empty for none. */
  inputs: MutationInput[]
  /** Each blog it files, and the folder it was in before (null for none), for a late Undo. */
  from: [feedId: number, folderId: string | null][]
  /** The folder it makes, if it makes one. */
  made: string | null
}

/**
 * Subscribe to every blog of a blogroll the member does not follow yet, and put those, and only
 * those, in one place (Tela Lists, screen 24): a blog already followed stays where it is. A filing
 * outlives an unsubscribe, so a blog followed once before would go back to its old folder: each is
 * filed where the member chose, No folder too. A folder chosen that is gone by now is none.
 */
export function subscribeAllPlan(
  t: Pick<Tables, 'subscriptions' | 'folders' | 'feedFolders'>,
  feedIds: readonly number[],
  to: Destination,
): SubscribeAllPlan {
  const fresh = unique(feedIds).filter((feedId) => !follows(t, feedId))
  if (fresh.length === 0) return { fresh, inputs: [], from: [], made: null }
  const target =
    to.kind === 'new' ? to.id : to.kind === 'folder' && t.folders.has(to.id) ? to.id : null
  const from: [number, string | null][] = []
  for (const feedId of fresh) {
    const was = folderOf(t, feedId)
    if (to.kind === 'new' || was !== target) from.push([feedId, was])
  }
  return {
    fresh,
    inputs: [
      ...fresh.map((feedId) => ({ type: 'subscribe', feedId }) as const),
      ...(to.kind === 'new' ? [{ type: 'putFolder', id: to.id, name: to.name } as const] : []),
      ...from.map(([feedId]) => ({ type: 'fileFeed', feedId, folderId: target }) as const),
    ],
    from,
    made: to.kind === 'new' ? to.id : null,
  }
}

/**
 * Undo Subscribe to all after it went to the server: each blog it added unsubscribed, and each it
 * filed back where it was, in a folder that is still there, or none. The folder it made is
 * deleted, which leaves what was in it in none, so only a blog that was somewhere else before is
 * filed back.
 */
export function undoSubscribeAll(
  plan: Pick<SubscribeAllPlan, 'fresh' | 'from' | 'made'>,
  t: Pick<Tables, 'folders'>,
): MutationInput[] {
  const back = plan.from
    .filter(([, was]) => plan.made === null || was !== null)
    .map(([feedId, was]) => {
      const folderId = was !== null && t.folders.has(was) ? was : null
      return { type: 'fileFeed', feedId, folderId } as const
    })
  return [
    ...plan.fresh.map((feedId) => ({ type: 'unsubscribe', feedId }) as const),
    ...back,
    ...(plan.made !== null ? [{ type: 'deleteFolder', id: plan.made } as const] : []),
  ]
}
