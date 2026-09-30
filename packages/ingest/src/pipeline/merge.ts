/**
 * One blog, one feed (ADR 0028). Two active feeds of a blog are one feed at two addresses when,
 * over the stretch of time both hold posts for, they hold the same post URLs, at least
 * `MIN_SHARED_POSTS` of them: a mirror such as FeedBurner, or a second format of the same feed
 * (`/feed/` and `/feed/atom/`). A category or a language feed differs inside that stretch and
 * stays its own feed. The alias merges itself into the canonical feed when it is next due.
 */
import type { SiteFeedPosts } from '@tela/data'

/** Fewer shared posts than this is too little to call two feeds one. */
export const MIN_SHARED_POSTS = 3

type Post = SiteFeedPosts['posts'][number]

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, '')

/** A post URL as two feeds of one blog might each spell it: scheme, `www.`, a trailing slash. */
export function postKey(url: string): string {
  try {
    const u = new URL(url)
    const params = [...u.searchParams].filter(([k]) => !k.toLowerCase().startsWith('utm_'))
    const query = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : ''
    return `${stripWww(u.hostname)}${u.pathname.replace(/\/+$/, '')}${query}`
  } catch {
    return url.trim()
  }
}

/** Whether two feeds hold the same posts over the time both cover. */
export function samePosts(a: Post[], b: Post[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const at = (posts: Post[]) => posts.map((p) => p.sortAt)
  const start = Math.max(Math.min(...at(a)), Math.min(...at(b)))
  const end = Math.min(Math.max(...at(a)), Math.max(...at(b)))
  if (start > end) return false
  const keys = (posts: Post[]) =>
    new Set(
      posts.flatMap((p) => (p.url && p.sortAt >= start && p.sortAt <= end ? [postKey(p.url)] : [])),
    )
  const inA = keys(a)
  const inB = keys(b)
  if (inA.size < MIN_SHARED_POSTS || inA.size !== inB.size) return false
  for (const k of inA) if (!inB.has(k)) return false
  return true
}

/** The feed a pair collapses into: the one on the blog's own host, else the older. */
export function canonicalOf(
  siteHome: string,
  x: { id: number; host: string },
  y: { id: number; host: string },
): number {
  let home: string
  try {
    home = stripWww(new URL(siteHome).hostname)
  } catch {
    home = ''
  }
  const xOwn = stripWww(x.host) === home
  const yOwn = stripWww(y.host) === home
  if (xOwn !== yOwn) return xOwn ? x.id : y.id
  return Math.min(x.id, y.id)
}

export type MergePlan = { target: number; move: number[]; carry: [number, number][] }

/**
 * Whether `feed` is an alias of another feed of its blog, and if so what merging moves: its posts
 * the target lacks, and the pairs whose read state carries over. Null when it is its own feed.
 */
export function planMerge(
  feed: { id: number; host: string },
  siteHome: string,
  feeds: SiteFeedPosts[],
): MergePlan | null {
  const self = feeds.find((f) => f.id === feed.id)
  if (!self) return null
  for (const other of feeds) {
    if (other.id === self.id) continue
    if (canonicalOf(siteHome, self, other) !== other.id) continue
    if (!samePosts(self.posts, other.posts)) continue
    const targetByKey = new Map(
      other.posts.flatMap((p) => (p.url ? [[postKey(p.url), p.id] as const] : [])),
    )
    const targetDedup = new Set(other.posts.map((p) => p.dedupKey))
    const move: number[] = []
    const carry: [number, number][] = []
    for (const p of self.posts) {
      const copy = p.url ? targetByKey.get(postKey(p.url)) : undefined
      if (copy !== undefined) carry.push([p.id, copy])
      else if (!targetDedup.has(p.dedupKey)) move.push(p.id)
    }
    return { target: other.id, move, carry }
  }
  return null
}
