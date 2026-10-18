# 0050 — Blogrolls: lists of blogs to share, each blog with a note, subscribed to at once

Status: accepted (2026-10-18). Amends 0025: two synced tables and six mutations join the
protocol, which stays at 3. Amends 0044: Discover gains a fifth tab, Blogrolls. Amends 0039: the
console's Discover area hides a blogroll from Discover and restores it. Takes up 0048's
later-rounds line for blogrolls; collections and Save are still to come.

## Context

Claude Design's Tela Lists draws three ways to group things: folders of a member's own
subscriptions, which shipped (0048, 0049), collections of posts, and blogrolls. A blogroll is a
member's named list of blogs to share, each blog with an optional note, private or public, which
anyone can subscribe to whole.

An engineering review of the design (2026-10-18) asked for twelve changes, and Claude Design
revised it. The revision answered six:

- a note editor on the owner's rows;
- Remove with Undo on the owner's rows;
- a Subscribe button that counts what it adds;
- a folder list that scrolls;
- a filter in Add blogs;
- the page a signed-out visitor sees.

It left six:

- where Follow and Recommend land;
- Make a blogroll from a folder;
- empty states;
- hard cases, apart from the reader count from three;
- an admin Hide;
- phone screens: only the subscribe sheet and the profile tab are drawn.

Production when this was decided (2026-10-18, read-only):

| Measure | Count |
|---|---|
| Members | 2 |
| Live subscriptions | 60 |
| Of those, to blogs outside the directory | 23 (38%) |
| Likes | 2 |
| Recommendations | 1 |
| Follows | 1 |
| Folders | 4 |

Two things follow. A blogroll held to the directory would leave out more than a third of what
members read, and that third is where a blogroll helps most. And any social count on a blogroll
names someone: in a beta of two, a like count of 1 says who liked it.

## Decision

**Core only.** A blogroll is made, named, described, filled, annotated, made public or private,
shared by its link, and subscribed to. Like, Recommend, Follow and "Save a copy" wait for the
collections round, so they are designed once for both. A like count of 1 names the liker, and
Recommend and Follow had nowhere to land: the Following page and the profile's Recommendations
tab are built for posts. The subscribe panel's "Follow it to hear about new additions" goes with
them.

**Two tables, synced to their member only** (migration 0012):

- `blogrolls` holds the list itself:
  - `id`: twelve letters and digits, minted on the device as a folder's is, and the blogroll's
    address, `/l/<id>`. 71 bits: two devices never mint the same one, and a private blogroll is
    refused to anyone else whether its id is guessed or not.
  - `name` (1 to 60 characters) and `description` (up to 280, line breaks kept).
  - `is_public`, with a version of its own, `public_version`.
  - `public_since`: the server's time when it first went public, never cleared.
  - `hidden_at`: the operator's Hide from Discover.
  - The usual clocks, soft-deleted. `updated_at` is the clock of the name and description only.
- `blogroll_blogs (blogroll_id, feed_id)` holds a blog in a blogroll:
  - `note` (up to 280 characters), on a clock of its own, `note_at`.
  - `added_at`, the list's order.
  - `updated_at`, the clock of putting in and taking out, and `removed_at`.
  - `user_id`, so the pull is the owner's alone.

  Keyed by feed, as a subscription and a filing are, so a merged address resolves through
  `merged_into`.
- `l` joins the reserved handles.

**Six mutations, each decided as its neighbours are.** Every statement is guarded by its mutation
id, takes its `at` clamped to the server's clock, and runs in a batch that starts with `bumpSeq`.

- **`putBlogroll {id, name, description, isPublic}`** makes a blogroll, or changes its name and
  description, to the later `at`.
  - Only on the member's own live row: it never revives a deleted one.
  - It makes none past 50.
  - `isPublic` counts only when it makes the row, and then sets `public_since`. After that,
    public or private is `setBlogrollPublic`'s alone.
- **`setBlogrollPublic {id, isPublic, base}`** is the profile's switches again (0031, issue #16).
  - A hide always applies.
  - A show applies only while `public_version` is still `base`, the version the device's
    confirmed rows hold, and the device waits while its own change is unsettled. So a stale
    device never makes public again what another made private.
  - Every change counts the version up, and a show sets `public_since` if it was never set.
  - It leaves `updated_at` alone, so a rename and the switch never decide each other.
- **`deleteBlogroll {id}`**: delete wins, as a folder's does. Its blog rows stay; the snapshot and
  every public answer read only live blogrolls.
- **`rollBlog {blogrollId, feedId}`** puts a blog in, or back, to the later `updated_at`.
  - It goes through the feed a merged one became.
  - The blogroll must be the member's and live, with fewer than 200 blogs in it.
  - A blog already in keeps its place. One put back goes to the end. Its place, `added_at`, is
    the device's own stamp (a day ahead of the server at most), not the clamped `at`: it decides
    no conflict, and clamped, a device whose clock runs ahead had every blog of a push tied at the
    server's `now` and listed by feed id instead of as put in (review).
  - Its note is untouched.
- **`unrollBlog {blogrollId, feedId}`** takes a blog out. `removed_at` keeps the first time, and
  `updated_at` moves forward even on a row already out, the lesson `unfollow` taught, so a put-in
  older than the second take-out cannot win. With no row it does nothing.
- **`noteBlog {blogrollId, feedId, note | null}`** writes or clears a note on its own clock. A note
  written on one device never brings back a blog another device took out, and a note outlives a
  removal, as a filing outlives an unsubscribe: put back, the blog has its note again.

The limits (50 blogrolls, 200 blogs; 60, 280 and 280 characters) are kept as `putFolder` keeps
its own: past one, nothing is written and the mutation is acknowledged, since two offline devices
may each be under the limit alone. Lengths are counted in code points, as SQLite's `length()`
counts them, not in UTF-16 units, which would let 140 emoji fill 280. A control character is
refused, as in a folder's name (0048): `invalid_name` in a name, and `invalid_text` in a
description or a note, where a line break is allowed.

**Others see every blog the owner put in, except those the operator rejected**
(`sites.listing = 'rejected'`). Not only listed blogs: 38% of live subscriptions are to blogs
outside the directory.

- A listed blog links to its page on Tela (`/s/<siteId>`), and any other to the blog itself.
- A reader count shows from three readers (0041), as everywhere else.
- Names, descriptions and notes show as written, never translated.
- A blog is named by its blog's title, or by its feed's while the blogroll holds another live feed
  of the same blog, so the two stay apart (`BLOG_NAME` in `packages/data/src/queries/blogrolls.ts`,
  and the device's `blogNameIn`). Within the blogroll, not across Tela: a second feed of an
  unlisted blog is one another member added privately, and a public name that changed with it
  would say so (review). Live rows only, so the address a merge took out never counts. Taking one
  of two feeds out gives the other its blog's name back, which is right for one real blog; the
  e2e fixtures, three unrelated blogs on one site, make it look like a rename, so their specs find
  rows by feed.
- The owner sees every row: a blog they do not subscribe to says "Not in your subscriptions", and
  one the operator rejected says that only they see it.

**Unsubscribing never touches a blogroll.** A blogroll recommends blogs; it does not mirror
subscriptions. So the owner's pull carries the feed and site rows of every blog in their live
blogrolls, subscribed or not (`rolledFeeds` in a snapshot, `newlyRolled` in a delta), without
their posts, and the device keeps those rows when it prunes.

**Subscribe to all copies once.**

- It counts what it adds: "Subscribe to 4" when the member already reads two of six blogs,
  "Subscribed to all" when none is left.
- The member chooses where the new blogs go:
  - a new folder, named after the blogroll and checked against their folders as Settings checks a
    name. This is the default, and it is not offered at 100 folders;
  - a folder they have, from a list that scrolls;
  - no folder.
- Only the new blogs are filed, so a blog the member already placed stays where they put it.
- It is one held group, so its Undo is all or nothing (0046): a `subscribe` per new blog, a
  `putFolder` for a new folder, and a `fileFeed` per new blog.
- A later change to the blogroll changes nothing in the member's subscriptions.
- It waits until the device has synced, so a blog the device has not heard of is never counted as
  new, and it counts again when pressed.
- Its changes, and its late Undo's, are `exact`: each touches the feed it names, never the one a
  merge made it (0028). The page is a public copy, which can name an address merged since, and
  the device cannot tell: followed through the merge, its `fileFeed` moved a subscription the
  member already had under the other address, and a late Undo unsubscribed it (Codex's review).
  Such a blog is now left alone both ways. A tela-api that predates the flag strips it.

**`view()` copies once.** A held Subscribe to all of 200 blogs is about 400 mutations, and the
reducer copied every table for each mutation it applied, so every recompute of the view replayed
400 copies. It now applies them in place over one copy (`applyInPlace`, with a copying wrapper for
the callers that want one), and an equivalence test pins the result to the old one. Measured
on a device of 60 subscriptions of 30 posts each, titles in four languages and 200 other feeds,
with that 400-mutation group pending (medians): V8 went from 173.5 ms to 0.41 ms a recompute, and
JavaScriptCore from 16.3 ms to 0.07 ms; with 50 pending, 38.6 ms to 0.50 ms on V8. A phone is
several times slower than the laptop measured, which is what made the old cost matter. With
nothing pending the view is still the confirmed tables themselves, so caches keyed by their
identity keep working.

**`/l/<id>` is a public page while the blogroll is public.** The edge renders it as it renders
`/s/:id` and `/@handle`, caches it five minutes per colo, and hands the data over. Anyone else
gets a 404 for a private, deleted or unknown blogroll, and the app's Not found, with no request,
for an address of another shape. The owner's page is rendered from the device, which holds their
blogrolls: the edge's 404 page boots the app, and the app finds the blogroll in the local store. On
another device that has not pulled it yet, the owner sees what others see, read-only, until the
pull lands.

**A signed-out visitor's actions are links to `/login?next=/l/<id>`**, as on a blog's page and a
profile. The design's join dialog for a shared link is not built. A page that opened a dialog
where its neighbours link would be the odd one out, and the header already offers Log in and
Join.

**Discover lists a public blogroll by itself** once three or more of its blogs are shown to
others.

- Newest public first, by `public_since` and id, thirty a page behind a key cursor, never an offset
  (0044). `public_since` is set once, so a blogroll made private and public again neither jumps
  the queue nor shifts a page under a reader.
- A card names its first five blogs. The device adds why it is there: "Yours", or that the member
  follows its owner.
- The operator can hide a blogroll from Discover in the console, and restore it.
  - Hidden, it keeps its page and its place on its owner's profile.
  - `hidden_at` never syncs, never moves `seq` and never touches `updated_at`, so the owner is not
    told.
  - There is no take-down of the page itself this round.

**Every member's own profile has a Blogrolls tab;** a visitor sees it only when there is a public
blogroll. The owner's tab is drawn from the device, private blogrolls included and marked, with
New blogroll.

**Make a blogroll from a folder.** The desktop manager has no folder menu, so it is a toolbar
button beside Rename and Delete folder; below `lg` it is an item in the folder's ···. It opens New
blogroll with the folder's name and blogs, private. Past 200 blogs it keeps the first 200 by name
and says so.

**What is held for Undo.**

| Action | Held while its toast shows (0046)? |
|---|---|
| Delete blogroll | Yes, then the page goes to the member's Blogrolls tab |
| Remove a blog | Yes |
| Subscribe to all | Yes |
| A tick in Add blogs, the Public switch, a note, an edit, New, Make from a folder | No, and no Undo |

The last row follows 0049's folder made with blogs: each is undone by doing the opposite, in
place.

**Merges carry blogroll rows.** `mergeFeed` (0028), after the filings, puts the target in every
blogroll the alias is live in, with the alias's `added_at` and note, unless the target is live
there already, whose own values win. A row of the alias already taken out goes along too, still
out, where the target has none, so its note outlives the merge as it outlives a take-out (review).
It then takes the alias out.

**Deferred**, for the collections round or later:

- Like, Recommend, Follow and Save a copy;
- Following entries ("Anna added Kerb Notes to Cities, on foot") and a recommended blogroll on
  the profile's Recommendations tab;
- an operator's take-down of a public page.

## Consequences

- **The protocol stays at 3.** The change is additive, as folders were (0048):
  - An older tela-api refuses the six mutations as invalid, so a blogroll made, edited or filled
    visibly goes back. `/l/<id>` is a 404, and `/discover/blogrolls`, a page that always exists,
    shows the shell and an empty tab.
  - An older shell ignores the new tables and has a `default:` for the new types.
  - A device copy written before the tables existed starts over from a snapshot, through `kept`.
- **A cached 404.** If someone opened a blogroll's link while it was private, the colo keeps
  answering that link with its Not found page for up to five minutes after the blogroll is made
  public. The app replaces it once its own request finds the blogroll; without a script it stays
  Not found until the copy expires. Made private, a page already open keeps working, and a reload
  is a 404 within minutes: the colo's 300 seconds, then the browser's 60.
- **An abuse gap.** A public blogroll's name, description and notes are a member's text on a
  public page. The console hides it from Discover, where strangers find it; its page and its
  profile tab stay until the operator makes it private by hand (OPERATIONS.md, *The admin
  console*).
- **A late Undo puts things back another way**, as 0049's do:
  - A removed blog is put back after the removal (`after: held.at`), so it comes back with its
    note, at the end of the list.
  - A deleted blogroll comes back as a new one (`blogrollAgain`): a new id, its blogs, their notes,
    and Public as it was, set by the `putBlogroll` that makes it. Its link changes, and the old one
    is a 404.
- **A held removal or deletion keeps its place under the limits** until it goes
  (`tablesBeforeHolds`, which `foldersBeforeHolds` now reads). Counted from the view instead, an
  Undo after something new took the place would push past the limit, and the server would drop
  it, as 0048 found for folders.
- **Rows by feed.** A blog read under two feeds can be in one blogroll twice, named apart by the
  feeds' titles.
- **The operator's column is the row's.** The nightly export holds `hidden_at`, but no pull
  carries it. The console may show the owner's handle: a public blogroll is already published
  under it, and 0039 keeps out only what members read.
- **Letting a big group go.** Subscribe to all of 200 blogs is about 400 mutations. Unsent changes
  stop at the hold (`unsent(50)`), so letting it go sends them in batches of 50, each idempotent.
- **`rollBlog` takes any feed, as `subscribe` does.** Add blogs offers only the member's
  subscriptions, but a push may name any feed id, and the owner's pull then brings that feed's row
  and its blog's. That is no reach `subscribe` lacks, which brings the same rows and more; holding
  `rollBlog` to feeds once subscribed would also refuse a late Undo of a delete for a blog left
  since. Left as is (review).
- **Blogroll ids reach Workers Logs.** `/l/*` runs tela-web, so each address opened is logged,
  private ones too. An id grants nothing: a private blogroll is a 404 to anyone but its owner,
  whose device renders it from its own rows.
