# 0062 — Feeds of Tela's own pages: a blogroll and Discover as RSS and OPML

Status: accepted (2026-10-25). Amends 0050: a public blogroll has an RSS feed and an OPML file of
its own. Amends 0044: Discover has two feeds, its newest posts and its blogs. Part of opening
Tela to the public (the launch plan's slice 8).

## Context

Opening sign-up makes Tela's public pages the way most people first meet it, and two of them are
lists that people already keep elsewhere:

- **A blogroll** (0050) is a list of blogs made to be shared. Feed readers share lists as OPML,
  and someone who reads in NetNewsWire or Feedly wants the list there, not a page to visit.
- **Discover** is the directory. Following its newest posts from any reader, or taking the whole
  directory into one, are the two ways a reader of feeds would use it.

What these may carry is already decided elsewhere, and the feeds must not loosen any of it:

- Only listed and featured blogs are public (0041).
- Tela never shows a post's full text publicly: a public page shows its title, its excerpt, its
  blog and its date, and links to the writer's own page.
- A writer can turn translation off for their blog (`sites.translation_opt_out`).
- Translation cost is bounded by the launch languages (0006), and nothing public may make Tela
  pay for a translation.
- A merged feed's posts are copies of its target's (0028).
- A public answer is cached per colo and is the same for everyone (0024, 0031).
- The launch puts a page's language in its address, as `?hl=`.

## Decision

**Four addresses, at the edge.**

| Address | What it is |
|---|---|
| `/l/<id>.rss` | A public blogroll's blogs' newest posts |
| `/l/<id>.opml` | A public blogroll, as a blogroll OPML |
| `/discover/articles.rss` | Discover's Articles, newest first; `?topic=` narrows it |
| `/discover.opml` | Discover's blogs, as the Blogs tab orders them; `?topic=` narrows it |

Each takes `?hl=` (`en`, `fr`, `zh-Hans`, `zh-Hant`), read as a page's is (`hlLocale`, ADR 0060):
in any case and as any tag of the language reads, so `zh-TW` is Traditional and `en-GB` English,
written back as Tela spells it; anything else pins nothing.
`hl` says which language the titles are read in, and the language of the feed's own words: its
title and description, from the reader's catalogues. A feed without `hl` carries every post as
written, and its own words in English.

**What an RSS item carries, and what it never does.**

- **Link and guid**: the post's own address, where its writer published it (`isPermaLink`). A feed
  reader opens the original, as a public page's link does.
- **Title**: the stored translation into `hl` when one exists, and the post as written otherwise.
  This is the reader's display rule for a public page (`shownTitle`, AGENTS.md). Three things
  narrow it:
  - never a translation into the language the post is in;
  - none for a blog whose writer turned translation off;
  - only a translation of the title and excerpt the post has now (`source_hash` against
    `title_hash`). A stale one may translate a title since rewritten, and a feed reader keeps
    what it was first given.

  The last two hold for every public answer, not only the feeds: the titles and excerpts a public
  page carries (`TITLES` and `EXCERPTS` in tela-api's `public-sql.ts`: the front page, Discover,
  a blog's page and a profile) leave out a writer's opted-out blog and a stale translation alike.

  `zh-Hant` is the stored OpenCC conversion, as everywhere (0038).
- **Description**: the public excerpt, translated with its title under the same rule, as plain
  text. Readers treat a description as HTML, so it is escaped for HTML and then for XML: an
  excerpt's `<b>` reads as those three characters.
- **`dc:creator` and `source`**: the blog's name, and its feed.
- **`pubDate`**: the date the post sorts by.
- **Never**: a body, `content:encoded`, an image, a body translation, a recommendation, a note or
  a person. A feed gives away nothing a public page does not show.

The channel has a title, a link to the page it is of on telaread.com (with `?hl=` when pinned), a
description, `atom:link rel="self"`, a `language` only when pinned, and a `lastBuildDate` that is
its newest item's date, not the time it was rendered. Fifty items, newest first; never a merged
feed's copy, never before its date, and only a post whose address is http(s).

**Listed and featured blogs only, in the OPML too.** A blogroll's page shows every blog its owner
put in except the rejected (0050), and names an unlisted one by its home page alone. Its feed
address is one a member typed: Tela publishes it nowhere, and it may carry a private token, as
paid and private feeds do. A listed blog's feeds are on its own page already.

- **A blogroll's OPML**: its name as the title, when it last changed (`dateModified`), its owner by
  name and profile (`ownerName`, `ownerId`). Its blogs come in its order, each by the feed a merge
  made it, once.
- **Discover's OPML**: the Blogs tab's order, each blog by the feed its Subscribe adds, at most
  500 (`MAX_OPML_FEEDS`): what Tela's own import reads, so the file comes back whole.

**A blogroll's feeds exist while others can see it.** They are a 404 when it is:

- private or deleted, as its page is;
- hidden from Discover by the operator, unlike its page;
- its owner's, once they are suspended or have left (`standingOk`).

0050 kept a hidden blogroll's page, which its link reaches. A feed travels further: into
aggregators and onto other sites, where strangers find it, which is what a hide is for. The
reports round makes Hide a moderation tool, and this keeps it one.

**Served like a public page.** tela-api answers `/api/v1/public/feeds/blogrolls/:id` and
`/api/v1/public/feeds/discover` with JSON that carries every post's titles and excerpts in each
launch language it has. The edge reads it through the same copy per colo as a public page
(`pageJson`) and renders the XML itself:

- One D1 read per colo serves a feed's four languages, and its RSS and OPML.
- The blogroll's answer is cached as its page is (`PROFILE_CACHE`), so one made private stops
  being served within minutes. Discover's is cached as its Blogs tab is (`PUBLIC_CACHE`).
- The edge matches a feed before a page. A name of no blogroll's shape (`/l/short.rss`) is a 404
  asked of nobody. `run_worker_first` lists Discover's two by name, never `/discover/*`; `/l/*`
  covered the blogroll's already.
- Each answer is labelled for what it is:
  - RSS is `application/rss+xml; charset=utf-8`.
  - OPML is `text/x-opml; charset=utf-8`, `inline` with a filename.
  - Every feed has an ETag over its bytes and answers a conditional GET with 304, since feed
    readers poll. A browser keeps it a minute.
  - Every feed is `noindex`: the page it is of is what a search lists.
  - When tela-api fails, a feed is a 503 that nobody keeps.
- No feed asks for a translation. It reads what is stored, so it costs no tokens.

**The pages offer them.** A blogroll's page and every Discover tab name their feeds in the head
(`<link rel="alternate">`, RSS and OPML) and show "RSS · OPML" at their foot. The RSS link is in
the reader's reading language: the edge renders a visitor's page in its locale, and a member's
links carry the language they read in. A blogroll offers its feeds only while it is public and
holds a listed blog, since its feeds would otherwise be a 404 or empty. Its owner's page offers
them once it is public.

**The service worker lets a feed through.** It answered every navigation with the shell, so a
click on a feed link would have booted the app on an address it has no page for, showing Not
found. A navigation to a path with an extension now goes to the network. No page of the app has
one, since handles have no dot.

## Consequences

- **A late translation may not reach a reader.** A post's title is translated minutes after it
  arrives while the budget lasts, and a pinned feed shows the original until then. Many readers
  keep an item's first title for good, and in a backlog, the newest posts in a pinned feed stay
  in their own language.
- **A hidden blogroll's page links to feeds that are a 404.** The page cannot tell: `hidden_at`
  reaches no device and no public answer (0050). Its owner can tell from the 404. That says no
  more than Discover leaving it out does already.
- **Made private, a blogroll's feed lasts minutes**: the colo's 300 seconds, then the browser's
  60. A feed reader keeps the items it already has.
- **An excerpt is the feed's own.** It comes from the writer's feed, so "Only use what my feed
  provides" (0061) leaves it as it is.
- **A shell worker from before this deploy** still answers a feed link with the app, once, until
  the browser updates the worker, which it checks on that navigation. That one click shows Not
  found.
- **Not built**: Atom and JSON Feed, a blog's own feed on Tela (`/s/<id>.rss`: the blog's own feed
  is the one to follow), a profile's recommendations as a feed, and Discover's OPML past 500 blogs.
