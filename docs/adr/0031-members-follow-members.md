# 0031 — Members follow members; what others do arrives by RPC, not sync

Status: accepted (2026-09-30). Amends 0025: two mutations and one synced table join the
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
name. The pull also re-sends a follow whose followee's profile changed (its seq is the larger of
the two), so a rename reaches the follower's list. `follow` and `unfollow` are mutations, decided
by the later `at` like a like. A follow of yourself or of nobody is a no-op, excluded in the
statement's `where`: the table's check is only a backstop, because a violated check would sink
the whole push.

**Members are named by their account id in public JSON.** The Follow button needs a stable key
for an optimistic row, and a handle can change between a click and its push. The id is random
and grants nothing: every route authorizes by session, and `x-tela-member` only guards stale
tabs. What it reveals, that @old became @new, a follower list reveals anyway.

**What the people you follow do comes by RPC.** `GET /api/v1/following` merges their
recommendations, their likes (only if they show them) and their subscriptions to listed blogs
(only if they show them), newest first, in windows of fourteen days. Its posts arrive as full
article rows held for the visit, like any post from outside the synced feeds (0025). The
Dashboard is the precedent for a member page served this way. "Readers you follow" on a blog page
is a member RPC too, beside the edge-cached public page, never in it.

**Liked posts are private unless the member shows them** (`profiles.public_likes`, default off),
like subscriptions. Authors still see how many likes a post has, never who liked it.

**The privacy switches are mutations.** `setProfile` carries `publicSubscriptions` and
`publicLikes`, so a switch flips at once and offline. The handle, name and bio stay behind
`PUT /api/v1/profile`, since a handle must be unique.

**Suggestions use only what is already public**: members who recommended posts from blogs you
read, and members whose public subscriptions overlap yours. Nobody is suggested because of a
private subscription or a private like.

## Consequences

- A member's device holds whom they follow and nothing about what those people do. The Following
  page needs the network, as the Dashboard does. The aside listing the people you follow does
  not.
- Public profiles and blog pages can lag a change by up to five minutes: the edge caches them.
  Settings says so beside the privacy switches, and the member's own device forgets its cached
  copy of their profile when the profile row changes.
- `MIN_CLIENT` stays 2, as for highlights. A shell that predates this ignores the new pull table
  and never sends the new mutations, and a device copy without a `follows` table starts over
  from a snapshot (0025). The residual risk is an old tab left open across the deploy, which
  shares the database and moves the cursor past a follow row it drops. The row comes back the
  next time the followee's profile changes. Otherwise it comes back after a sign-in, when the
  copy starts over.
- The profile says nothing about the languages a member reads. The design's "Reads in" would
  have published the private never-translate list.
- Out of scope, and absent from Settings rather than shown disabled: follow approval, email
  notifications and digests, uploaded avatars, and deleting an account. Approval needs somewhere
  to approve requests, which the design does not draw.
