/**
 * SQL that every reader of others' blogrolls shares (ADR 0050): the public page, profile cards,
 * Discover and the admin console all ask which blogs others see, how many, by what name, and
 * whether a blogroll is in Discover, the same way.
 *
 * Aliases are fixed identifiers written into the fragments, never input.
 */
import { BLOGROLL_DISCOVER_MIN } from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'

/**
 * The blog rows of the blogroll aliased `r` that others see, as `bb` joined to `f` (feeds) and
 * `s` (sites): put in and not taken out, of a blog the operator has not hidden. A merged feed's
 * row stays: subscribing to it subscribes to the feed it became, and a tela-jobs rolled back
 * before the carry-over leaves it the only row.
 */
export const visibleBlogsFrom = (r: string): SQL =>
  sql.raw(`blogroll_blogs bb join feeds f on f.id = bb.feed_id join sites s on s.id = f.site_id
    where bb.blogroll_id = ${r}.id and bb.removed_at is null and s.listing <> 'rejected'`)

/** How many blogs others see in the blogroll aliased `r`: rows, as its page lists them. */
export const visibleBlogCount = (r: string): SQL =>
  sql`(select count(*) from ${visibleBlogsFrom(r)})`

/**
 * What a blog in a blogroll is called, from `f` and `s`, as the reader names a feed
 * (`feedTitle`): its blog's title, or the feed's own when the blog has another live feed, so the
 * two stay apart; null when neither has one, and the page shows the host. Whether the blog has
 * another feed, not whether the blogroll holds it: a name that changed with what else is in the
 * list would rename a blog when its neighbour was taken out.
 */
export const BLOG_NAME = sql.raw(`case when exists (
    select 1 from feeds f2
    where f2.site_id = f.site_id and f2.id <> f.id and f2.merged_into is null
  ) then coalesce(f.title, s.title) else coalesce(s.title, f.title) end`)

/**
 * Whether the blogroll aliased `r` is in Discover: public, not deleted, not hidden by the
 * operator, and with at least `BLOGROLL_DISCOVER_MIN` blogs others see.
 */
export const inDiscover = (r: string): SQL =>
  sql`(${sql.raw(`${r}.is_public = 1 and ${r}.deleted_at is null and ${r}.hidden_at is null`)}
    and ${visibleBlogCount(r)} >= ${BLOGROLL_DISCOVER_MIN})`

/** Whether others can open the blogroll aliased `r` at all: public and not deleted. */
export const isShown = (r: string): SQL =>
  sql.raw(`(${r}.is_public = 1 and ${r}.deleted_at is null)`)
