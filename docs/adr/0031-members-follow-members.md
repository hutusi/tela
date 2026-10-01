# 0031 — Members follow members; what others do arrives by RPC, not sync

Status: accepted (2026-09-30). Amends 0025: three mutations and one synced table join the
protocol.

## Context

Tela's social side was one-directional: a member recommends a post, the blog's author sees the
note, and anyone can read a public profile. The Tela v2 design adds the other half. A reader
follows other readers, a Following page shows what they recommend, like and subscribe to, a
profile counts followers, and a blog's page names the readers you follow who read it.

Three things about it do not fit the way everything else reaches the device (ADR 0025):

- **It is other people's rows.** A pull sends a member their own rows and the shared rows of the
  feeds they read. The people you follow change their recommendations and subscriptions on their
  own schedule, and each follower would need a copy of each change.
- **Privacy is decided at read time.** Likes and subscriptions show only if their owner chose
  to show them, and that choice can be taken back. A synced copy would have to be retracted from
  every follower's device.
- **Public pages are cached at the edge** for everyone (0024). Nothing on them can depend on who
  is looking.

## Decision

**A follow is one-way, public, and needs no approval.** `follows (follower_id, followee_id)` is
soft-deleted and synced to the follower only, as a row carrying the followee's handle and display
name. The pull also re-sends a live follow whose followee's profile changed (its seq is the larger of
the two), so a rename reaches the follower's list; an unfollow keeps its own seq, and the pull
selects, orders and pages follows by that one expression. `follow` and `unfollow` are mutations, decided
by the later `at` like a like. A follow of yourself or of nobody is a no-op, excluded in the
statement's `where`: the table's check is only a backstop, because a violated check would sink
the whole push.

**Members are named by their account id in public JSON.** The Follow button needs a stable key
for an optimistic row, and a handle can change between a click and its push. The id is random
and grants nothing: every route authorizes by session, and `x-tela-member` only guards stale
tabs. What it reveals, that @old became @new, a follower list reveals anyway.

**What the people you follow do comes by RPC.** `GET /api/v1/following` merges their
recommendations, their likes (only if they show them) and their subscriptions to listed blogs
(only if they show them), newest first, thirty entries a page behind a cursor of (time, offset,
key). A day's likes, or new subscriptions, are one entry per person, placed at the newest of them
over the whole day, so a group lands whole on one page and a page is never cut inside one. Windows
of days were tried first: they left a first page empty when the activity was older than the
window, and a day busier than a page could not be paged past. The cursor carries the offset the
walk grouped days under, so its pages agree on what a day is. A group's place can move if its day
changes between two page requests (a like, an unlike). The device drops an entry it already holds;
a group that moved up shows when the first page is next asked for; and when an entry the first
page held has moved down or gone, the refresh keeps only the fresh page rather than older pages
that no longer say where it is. Its posts arrive as full article rows held for the visit, like
any post from outside the synced feeds (0025). The Dashboard is the precedent for a member page
served this way. "Readers you follow" on a blog page is a member RPC too, beside the edge-cached
public page, never in it.

**Liked posts are private unless the member shows them** (`profiles.public_likes`, default off),
like subscriptions. Authors still see how many likes a post has, never who liked it.

**The privacy switches are a mutation of their own, `setPrivacy`**, so a switch flips at once and
offline. Each switch goes to the later `at`, on a clock of its own (`public_likes_at`,
`public_subscriptions_at`): a device reconnecting with an older "show" cannot make public what
the member has since hidden, and one switch's change never decides the other's. It is a type of
its own rather than more fields on `setProfile` because a tela-api that predates it must refuse
it: an older `setProfile` would strip the fields, acknowledge the change and drop it. The handle,
name and bio stay behind `PUT /api/v1/profile`, since a handle must be unique; a shell from before
the switches still sends its form's `publicSubscriptions` there with every save, so that path may
only hide; its "show" saves and quietly changes nothing, which lasts only until that tab loads the
newer shell.

**Suggestions use only what is already public**: members who recommended posts from blogs you
read, members whose public subscriptions overlap yours, and members who recommended anything in
the last thirty days. Nobody is suggested because of a private subscription or a private like.

## Consequences

- A member's device holds whom they follow and nothing about what those people do. The Following
  page needs the network, as the Dashboard does. The aside listing the people you follow does
  not.
- Public profiles and blog pages can lag a change by up to five minutes: the edge caches them.
  Settings says so beside the privacy switches, and the member's own device forgets its cached
  copy of their profile when the profile row changes. A browser that showed a page within the
  last day may show its own copy once more, under the public JSON's day of
  stale-while-revalidate (0024), and fetches the new one behind it: nothing it had not already
  shown.
- The Following page's device copy is checked against a fresh first page only. An entry that
  appears at an old time below that page (a re-subscription keeps its first date; a followee who
  starts showing likes shows old days) stays out of the older pages already loaded until the next
  visit. Finding it would mean walking every loaded page again on each return to the page.
- `MIN_CLIENT` stays 2, as for highlights. A shell that predates this ignores the new pull table
  and never sends the new mutations, and a device copy without a `follows` table starts over
  from a snapshot (0025). The residual risk is an old tab left open across the deploy, which
  shares the database and moves the cursor past a follow row it drops. A follow it dropped comes
  back the next time the followee's profile changes; an unfollow it dropped clears when the
  member unfollows again, since an unfollow always moves the row's seq. Otherwise either comes
  back after a sign-in, when the copy starts over.
- Rolling back is one-way. tela-api may go back alone: a pull without `follows` reads as having
  none, and public pages from the older API render without what it never said. tela-web may not
  go back past this release, because the shell before it throws on a pending follow at boot.
  This release's reducer ignores mutation types it does not know, so the next release can be
  rolled back to it (OPERATIONS.md).
- The feed groups a person's day of likes or subscriptions over all of it, so each request reads
  every like and new subscription of the people followed, not one window of them. That is cheap
  at the beta's size; past it, the query wants a lower bound (only days that could still reach
  the page) or a stored per-day summary.
- The ordering follows device clocks, clamped to the server's, as every other conflict in 0025
  does: a device whose clock runs minutes slow can lose a newer "hide" to an older "show" made
  elsewhere for that long. Making a hide always win would need the protocol to say which version
  a change was made against.
- The profile says nothing about the languages a member reads. The design's "Reads in" would
  have published the private never-translate list.
- Out of scope, and absent from Settings rather than shown disabled: follow approval, email
  notifications and digests, uploaded avatars, and deleting an account. Approval needs somewhere
  to approve requests, which the design does not draw.
