# 0066 — A daily limit on posts from blogs a member doesn't follow

Status: accepted (2026-10-27). Amends 0025's account of the edge: `/o/*` and `/img/*` now ask
tela-api before serving, and public answers carry no content key. Shared by the web and every app
(0064, 0065).

## Context

Any signed-in member may read any post Tela holds in full: the web's rule, which the owner kept for
apps too. Until now, bodies, translations and images checked only that a session existed, and every
public answer carried each post's content key. So one account could copy Tela's whole archive by
walking public pages, and an app would make that a loop.

## Decision

**A member opens as many posts as they like from blogs they subscribe to.** From any other blog,
they may open **100 posts a UTC day** (`member.unsubscribedPostsPerDay`, a runtime setting: `null`
is no limit, `0` is none).

- **One count, shared** by the web and every app the member connected.
- **Counted per post** (content key) per day. Opening it again that day, or fetching its
  translation or images, is free.
- **Kept posts from blogs the member left count too.** Otherwise liking any post would make it
  free.
- **Admins are exempt on the web**, as from every member limit, and never through an app.

100 is more than anyone reads in a day from blogs they don't follow, and it makes copying Tela's
~6,400 posts take one account over two months.

**One decision, `admitOpens`, in one batch:**

- a key whose post is in a feed the member subscribes to is allowed;
- any other key is a conditional insert into `post_opens` that runs only while the day's count is
  under the limit;
- a key already opened today is allowed.

The answer names the refused keys, with when the day starts again.

**Every edge asks before it serves.**

- **tela-web** asks tela-api once per object or bundle request, over its service binding, and
  keeps each allowed (member, key) in the colo until the day ends, so images and translations of an
  allowed post ask nothing more.
- **tela-gateway** asks the same function with the app's token, and keeps the answer for 60
  seconds, so cutting an app off reaches its images within a minute.

A refusal is 429 with `Retry-After`. In a bundle, the refused keys are listed apart.

**No content keys in public answers**, for anyone: Discover, blog pages, profiles, blogrolls. The
colo's cached public pages stay the same for visitors and members. A member who opens a post from a
public page gets its row from `GET /api/v1/articles/:id` (the API's `/v1/articles/{id}`). Older
shells expect the key, so `MIN_CLIENT` goes to 5, and tela-web deploys before tela-api.

**The reader, refused,** shows the excerpt with "Subscribe to keep reading" and "Read it on the
blog", and when the count starts again. Its prefetch does not ask for a refused key again before
then.

## Alternatives considered

- **Counting when a post is opened from a public page, not when its body is fetched.** That is
  cheaper, but anyone who has a content key fetches `/o/` directly, so it guards nothing.
- **Serving first and counting behind.** That costs no round trip, but each colo learns the member
  is over only after a bundle has gone, so a scraper spread across colos gets many bundles a day.
- **Subscribers only.** That was the owner's first brief, and it was dropped: Discover and blog
  pages are for reading posts.

## Consequences

- **The first open of a body the device does not hold waits for one round trip to tela-api:** 10–50
  ms from Asia, up to ~200 ms from Europe and America. Prefetch hides it for subscribed posts.
- **`post_opens` is a counter,** swept after two days, left out of the export, and named in the
  privacy page.
- **For writers says it:** subscribers read in full, others a few posts a day, visitors excerpts.
