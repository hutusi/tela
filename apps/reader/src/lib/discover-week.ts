/**
 * This week on Discover (ADR 0044), composed on the device, since only the device knows which
 * blogs its member reads. Led by the week's most recommended posts once enough of them are left
 * to lead with; until then by the front page's edition, the newest post of each blog, so a week
 * nobody recommended anything in reads as a week of new posts rather than an empty page.
 */
import type { DiscoverPost, DiscoverSite, WeekData } from '../views/types'
import type { Hidden } from './discover-overlay'

/** Recommended posts it takes, after hiding the member's own blogs, to lead with them. */
export const WEEK_MIN_RECOMMENDED = 3
/** The lead and the four ranked under it. */
export const WEEK_SHOWN = 5
export const NEW_BLOGS_SHOWN = 3

/** `recommended`: by the week's recommendations; `week` and `latest`: the edition's. */
export type WeekSpan = 'recommended' | 'week' | 'latest'

export type ComposedWeek = {
  span: WeekSpan
  lead: DiscoverPost | null
  /** Ranked two to five. */
  rest: DiscoverPost[]
  newBlogs: DiscoverSite[]
}

export function composeWeek(data: WeekData, hidden: Hidden): ComposedWeek {
  const visible = (p: DiscoverPost) => !hidden(p.site.id, p.article.feedId)
  const recommended = data.recommended.filter(visible)
  let span: WeekSpan
  let posts: DiscoverPost[]
  if (recommended.length >= WEEK_MIN_RECOMMENDED) {
    span = 'recommended'
    posts = recommended.slice(0, WEEK_SHOWN)
    // Topped up from the edition, never with a post or a blog already shown.
    const articles = new Set(posts.map((p) => p.article.id))
    const sites = new Set(posts.map((p) => p.site.id))
    for (const p of data.edition.posts) {
      if (posts.length >= WEEK_SHOWN) break
      if (!visible(p) || articles.has(p.article.id) || sites.has(p.site.id)) continue
      posts.push(p)
      articles.add(p.article.id)
      sites.add(p.site.id)
    }
  } else {
    span = data.edition.span
    posts = data.edition.posts.filter(visible).slice(0, WEEK_SHOWN)
  }
  return {
    span,
    lead: posts[0] ?? null,
    rest: posts.slice(1),
    newBlogs: data.newBlogs.filter((b) => !hidden(b.id, b.feedId)).slice(0, NEW_BLOGS_SHOWN),
  }
}
