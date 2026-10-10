# 0044 — Discover's four tabs; what is the member's own is worked out on the device

Status: accepted (2026-10-10). Amends 0031: readers are suggested by one rule, on Discover and on
Following, and the device does the matching.

## Context

Discover was one page: a grid of public blogs by topic and language. The Tela v5 design makes it
four tabs, so a member finds posts and people outside their subscriptions as well as blogs:

- **This week**, the new home at `/discover`: the week's most recommended post as a lead card with
  readers' notes, four more ranked under it, blogs new in the directory, and readers to follow.
- **Articles**: posts from public blogs, the most recommended or the newest, by topic and language,
  each with a line saying why it is there ("Ann, whom you follow, recommended it").
- **Blogs**: the directory as it was.
- **Readers**: members to follow, grouped by why ("Recommended posts you liked too", "Found posts
  before others did", "Explain what they recommend").

The design is built on social signals, and production had almost none of them when this was
decided (2026-10-10, read-only): 2 members, 1 recommendation without a note, 1 like and 0 follows,
against 116 public blogs, 2,939 public posts and 243 posts in the last seven days. ADR 0018 learned
that a page built on what nobody has made yet reads as broken, not as new.

Three things on those pages are personal: a member's own blogs should leave the week and Articles,
"whom you follow" depends on whom they follow, and two of the design's reader groups match their
own likes. ADR 0031 says a cached public page never depends on who is looking.

## Decision

**One public answer per tab, the same for everyone; the personal part is the device's.**
tela-api answers `GET /api/v1/public/discover/week`, `/articles` and `/readers` (and the Blogs page
keeps `GET /api/v1/public/discover`). The edge renders each for visitors and caches it, and the SPA
applies, from the rows it already holds (ADR 0025):

- the blogs the member reads, by site, so their posts and new-blog cards leave This week and
  Articles. The Blogs tab keeps them, showing "Subscribed", as a directory should;
- who among a post's recommenders the member follows: each post carries up to twenty recommender
  account ids, which are public on profiles already;
- the reader groups that use the member's likes, recommendations and blogs.

Nothing personal is sent to find any of it, so no answer and no edge page depends on who asks. The
sets a page hides and leaves out are taken once when it opens: a Subscribe or a Follow from the
page leaves its card in place, showing that it took.

**This week falls back to the front page's edition.** It leads with the week's recommendations
(rolling seven days, by count, then newest) once three recommended posts are left after hiding the
member's blogs, topped up to five from the edition without repeating a post or a blog. With fewer,
it is the edition itself, the newest post of each public blog this week, or the latest posts when
the week has none (ADR 0035), headed "New this week" or "Latest in the directory" rather than
"Most recommended". The device decides, because only it knows what to hide. A weekly edition
rebuilt on Mondays, as the design proposed, was not built: a rolling week costs no stored state and
reads the same in a beta this size.

**Articles pages by key, and only the newest stream.** The newest posts are cut into pages of
thirty by `(sort_at, id)`, never by offset (the export's lesson in AGENTS.md). The week's
recommended posts come whole on the first page, at most thirty, and are never paged: their counts
move between requests, so a page boundary drawn through them would repeat or skip a post. "Most
recommended" is those, then the newest stream; "Newest" is the stream alone, so the endpoint never
sorts and the sort is only a page key at the edge. With no recommendations "Most recommended" is
simply the newest. A device that hides many posts asks for up to two more pages by itself before it
offers More.

**New in the directory never says how a blog got there.** The design labelled each new blog with its
door ("Picked by Tela's editors", "Listed by its readers"); ADR 0041 forbids that. A blog is new by
`max(created_at, claimed_at)`, every listed blog alike, which a blog's public id already says.
`reviewed_at` is never read, and no door is left out: showing only claimed, community and curated
blogs was tried and reversed in review, because a blog's absence from New then says it was listed
from the queue, and so, in a beta of two, that the other member reads it.

**One suggestion rule for Readers, This week and Following.** It combines the design's signals with
ADR 0031's. tela-api names a pool of members with a live recommendation or public subscriptions to
listed blogs, at most a hundred by recent activity, each with what their profile already shows:
their newest recommendations as `[article, blog]`, the listed blogs they show they read, their
recommendations and notes of the last thirty days, their earliest find, and their newest note. The
device places each reader once, in the first group that fits:

1. **Recommended posts you liked too**: their recommendations include a post the member liked or
   recommended.
2. **Read the blogs you read**: they recommend posts from the member's blogs, or the blogs they show
   overlap the member's (ADR 0031's two overlaps).
3. **Found posts before others did**: they recommended a post that two or more readers recommended
   after them. "After" is by the recommendation's id, the order tela-api first received them: its
   `created_at` is the device's `at`, which push clamps only from above. A recommendation made
   again keeps its row, and so its place; the same goes for a post's newest note.
4. **Explain what they recommend**: two or more notes this month, on at least half of their
   recommendations.
5. **Recommending lately**: any recommendation this month (ADR 0031's third signal).

A visitor sees groups 3 to 5. Following's aside shows the first five, This week the first three.
Nobody is suggested because of a private subscription or a private like, as before; a member's own
likes are matched against others' public recommendations on their device, not on the server. The
Readers tab says so in its intro, and the Privacy page says that recommending, or showing the blogs
you read, can put you in the pool.

## Consequences

- `/discover` is This week. An address from before the tabs (`/discover?topic=…`, `lang`, `page`)
  is answered 301 at the edge to `/discover/blogs` with its whole query, which a sign-in's return
  adds to; the SPA does the same. `/discover/articles`, `/discover/blogs` and `/discover/readers`
  join `run_worker_first` by exact path, and their edge routes treat a 404 from tela-api as no
  answer (`alwaysExists`), so a tela-web deployed ahead of tela-api never caches a Not found page.
- The three answers are cached as a profile is (`PROFILE_CACHE`, five minutes at most in a
  browser), not as Discover's blogs are (a day of stale): the readers pool carries what members
  chose to show, and ADR 0031 promises a privacy switch reaches public pages in minutes.
- `/api/v1/following` no longer suggests anyone. It keeps answering `suggested: []`: a shell cached
  before this reads the field in render and would unmount the page without it.
- A member's HTML page from the edge, before the SPA boots, is the visitor's: their own blogs show
  for a moment and then leave.
- Two indexes join the schema: `articles (sort_at, id)` for the newest stream and its 90-day
  language counts, `recommendations (created_at)` for the week.
- **The pool is the ceiling.** Groups 1 and 2 match only within the hundred readers tela-api names,
  where ADR 0031's server query matched every recommendation. At this size it is everyone. When
  the pool fills, the way out is a member endpoint for those two groups, or a summary per member
  kept by a job, and `/readers`, which reads every profile on each request a browser makes past its
  cache, should then be cached at the colo as well.
- No mutation, synced table or `MIN_CLIENT` change: either Worker can roll back alone. An older
  tela-api answers the new tabs with nothing (empty pages, an empty aside); an older shell shows the
  old Discover and an empty aside.
