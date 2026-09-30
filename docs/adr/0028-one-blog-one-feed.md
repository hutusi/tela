# 0028 — One blog, one feed: an alias merges into the blog's canonical feed

Status: accepted (2026-09-29). Extends the redirect rule in `ingestFeed`, where a feed that
permanently redirects onto another feed's URL is left alone as soon as somebody reads it.

## Context

Posts belong to feeds, and a reader follows feeds. The same blog can reach Tela at two feed
addresses:

- a mirror such as FeedBurner;
- a second format of the same feed, such as WordPress's `/feed/` and `/feed/atom/`.

The owner's OPML import brought in 阮一峰's FeedBurner address while Discover already had his own
Atom feed. Provenance filed both under one blog, but they identify posts differently (URLs as
GUIDs against `tag:` ids), so three posts were stored twice and the blog's page listed them twice.

Two things rule out the obvious fixes:

- **Skipping a post another feed of the blog already holds** would take it out of the list of
  anyone who follows only the second feed.
- **Recognising the duplicate when the feed is added** is impossible for an OPML import, which
  registers feeds without fetching them. A feed only joins its blog's site after its first fetch
  adopts the declared home.

## Decision

**Two active feeds of one blog are one feed at two addresses when, over the stretch of time both
hold posts for, they hold the same post URLs, at least three of them.**

- **How posts match:** URLs are compared ignoring scheme, `www.`, a trailing slash and `utm_*`
  parameters.
- **Why a window, not whole histories:** a mirror often carries more history than the blog's own
  feed, and both were subscribed to at different times. The window is the intersection of the
  two feeds' date ranges.
- **What stays separate:** a category or a language feed holds fewer posts than the blog's feed
  inside that window, so it keeps its own feed.

**The canonical feed** is the one on the blog's own host, whichever is older; between two feeds
on the same footing, the older one.

**The alias merges itself when it is next due**, before any request, in a fenced batch under its
own lease:

- it is paused with `merged_into` set, so no sweep fetches it again;
- its readers follow the canonical feed, keeping the higher watermark;
- its posts the canonical feed lacks move across;
- their titles, translations and read states go with them. A pull finds titles by feed and
  every change by seq, so each is restamped and a title is refiled under the canonical feed.
  Without that, a device following the canonical feed got the moved post but not its title,
  its translation, or the fact that it was read. A title written after the merge takes its feed
  from the post, so a title job still leased on the alias files it in the right place too;
- a read on a duplicate carries over to the canonical copy;
- a read that only the alias's watermark implied (`markAllRead`) is written down as a read, on
  the moved posts and on the canonical copies, for readers who left the alias too. Once a post is
  the canonical feed's, no alias watermark covers it, and compaction may already have dropped
  the row that said it was read.

The duplicates stay on the paused alias, where no list shows them. Nothing is deleted, so no
tombstone is needed and a wrong merge can be undone by hand (OPERATIONS.md).

**The old address keeps working.** Adding or importing a merged feed's URL subscribes to the
canonical feed, and so does a device that still pushes `subscribe` with the old id. Discover, a
blog's page and search never pick a merged feed.

## Consequences

- **A newly imported alias shows duplicates for one fetch interval:** its first fetch files it
  under the blog, and its second merges it.
- **Likes are not carried.** A like on a duplicate keeps that copy on the member's device
  (liked posts are kept), beside the canonical copy. Carrying likes would mean recounting them;
  at one reader, not worth it.
- **A category feed can be merged by mistake** in the rare case where every post in the window
  is in that category. Its readers then get the whole blog.
- The redirect rule is unchanged: an alias reached by a permanent redirect still stores nothing
  when nobody reads it, and keeps its own URL when somebody does. It becomes a content alias as
  soon as the two share posts.
