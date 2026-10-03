# 0035 — The front door: the edge renders `/` for visitors, and the shell comes from elsewhere

Status: accepted (2026-10-02). Amends 0025: `/`, `/about`, `/privacy` and `/terms` join the public
pages the edge renders, and the service worker takes its shell from `/__tela/shell`. Reverses
DESIGN.md's rule of 2026-10-01 that a visitor's interface language is chosen only on the sign-in
page.

## Context

A signed-out visitor at `/` gets a 24-line placeholder, drawn only after `/api/v1/me` has answered,
so the page is blank until then. A link to tela.ainaive.com previews as the shell's generic title.
The header offers a visitor pages only a member can use (Reading, Search), and the way in is a
code an operator sent. The owner has designed the replacement: a landing that is an edition of what
the public blogs wrote this week, a page For writers, About, Privacy and Terms, one sheet for
signing in and joining (0034, 0036), and a header of its own for visitors.

`/` is not like the other public pages in three ways:

- **It is the app shell.** The service worker fetches `/` as the shell and answers every
  navigation with it. Once the edge renders `/`, what a visitor's worker fetches there would be
  the landing, with its `#tela-data` handover, and every page would paint it until the app
  replaced it.
- **Members leave it.** `/` sends a member to `/reading`. A page cached for visitors must never be
  what a member gets, and rendering one only to throw it away costs a member a tela-api call.
- **Its numbers are live.** Production on 2026-10-02 holds 35 public blogs in 6 languages, about
  ten posts a day, and 17 blogs in 4 languages over the last week. The design's "over 2,000" and
  "11 blogs in 8 languages" were placeholders, and the copy must be true.

## Decision

**The landing and the info pages are rendered at the edge for visitors**, like Discover, so they
read without JavaScript, a shared link previews with the page's own title, and indexing follows
`TELA_PRIVATE_BETA`: noindex during the beta, indexable after it, with no other change.
`run_worker_first` gains `/`, `/about`, `/privacy` and `/terms`. The info pages take no data from
tela-api (their route has `api: null`): their copy is in the bundle, and the edge renders and
caches it per locale and deploy.

**A member at `/` gets the plain shell, decided by the cookie.** A request for `/` that carries
`tela.session_token` is answered with `assets.fetch` before the page cache is consulted: no tela-api
call, and nothing stored. The cookie's presence costs nothing to read; validating it would cost a
D1 read on every member's visit to `/` once the five-minute cookie cache has lapsed. A member
whose token has expired, or a visitor holding a stale one, gets the shell, and the SPA shows the
landing after one round trip. Every browser response at `/` says `vary: cookie`; the stored copy
does not, because workerd's cache ignores Vary and refuses `*`, and only visitors' renders are
stored at all. The private-beta `x-robots-tag` goes on both branches.

**A failed edition is the plain shell, never a 404.** Any answer from `/api/v1/public/front` but a
200, a 404 included, gives the plain shell, uncached, and so does a call that throws or has not
answered within three seconds: before this, `/` was a static asset nothing could slow down, and a
cold colo now asks D1 in Singapore for it. A 404 there means tela-web shipped before
tela-api has the route, or tela-api was rolled back; Discover's rule, that a 404 is a page that
does not exist, would put "not found" on the home page in every colo for five minutes.

**The service worker takes its shell from `/__tela/shell`** (`SHELL` v3). That is a path the edge
never renders, so the single-page fallback answers it 200 with `index.html` (`/index.html` itself
redirects to `/`). The worker still stores the shell under `/`, and refuses HTML that carries
`id="tela-data"` or lacks `<div id="root"></div>`. v3's activation drops whatever a v2 worker kept,
including a landing it fetched from `/` between the deploy and its replacement. `/*` and
`/__tela/*` never go into `run_worker_first`: either would put the Worker, and a rendered page, in
front of the shell again.

**The edition.** One post per public blog, its newest; those from the last seven days, or, when
the week is empty, the latest ones; at most eleven. The lead is the first post with an excerpt that
takes three minutes or more to read, or else the first. The counts are live and written as ICU
plurals, so the page says what is true that day: "A confluence of 35 independent blogs", "This
week, 17 blogs wrote in 4 languages", or "The latest from 3 blogs". Titles open as written. A link,
`?titles=translated`, shows them translated into the reader's language, with the translated
excerpt; every title carries its `lang`, and the language is named in its own name or the reader's.
Each mode is a page of its own in the edge cache, and nothing else in the query reaches the key.
`GET /api/v1/public/front` is one batch, cached as a public profile is (a minute in the browser,
five at the edge): for each feed one seek through `articles_feed_sort_idx` finds its newest post,
then the newest across a blog's feeds is kept, for at most 60 blogs, beside the week's counts.
Joining feeds to articles before the limit, as Discover does, reads every article of every public
blog.

**The SPA keeps the landing on screen while it learns who is there.** `Home` sends a member to
`/reading`, and shows the landing to a guest and to a device whose session is still `unknown` and
which holds no member (`store.userId === null`). It used to render nothing until `/me` answered, so
the edge's page went blank at the first commit (the SPA mounts with `createRoot`, not hydration) and
came back. The landing's root has no `animate-fade`, so the copy a visitor is already reading does
not blink out and fade back when the SPA replaces it. Its static copy needs no data, and only the
edition shows a skeleton while it loads, since a returning visitor's worker serves the plain shell
and their landing fetches the edition itself. Views read `window` and `document` only in effects, as
the edge has neither.

**`/join` and `/writers` stay in the SPA.** `/join?code=` must never reach a Worker: tela-web has
Workers Logs on, and a code in a logged URL is a code anyone who reads the logs can use. It does
not, because `run_worker_first` is a list, and the asset router then answers every path the list
does not name with the app, a navigation or not, without running tela-web. Measured in production
on 2026-10-02: `/join?code=` fetched as a link unfurler does, with no `Sec-Fetch-Mode`, came back
without the `x-robots-tag` tela-web puts on every answer during the beta, and `/__tela/shell`
likewise. The SPA reads the code, then removes it from the address bar. `/writers` is a page for
the beta and stays noindex through the shell's own meta tag; it can move to the edge when the beta
ends without changing its address.

**Visitors get a "Read in" pill.** It sets the interface language and the titles' language together,
from the header. That reverses the rule of 2026-10-01 (DESIGN.md) that the interface language is not
in the header and a visitor changes it only on the sign-in page: the first thing a visitor needs to
know is whether they can read the page at all, and the front page now shows titles in several
languages. The visitor header keeps 56 px and one shrinkable item, the nav: from `sm` up the logo,
Discover, For writers, Read in, Log in and Join; below `sm` the logo, the nav and Join. It has no
Reading pill and no search. Log in and Join are links to `/login` and `/join`, opened as the sheet
when JavaScript runs, so they work before it does.

**The copy says only what Tela does.** For writers leaves out what Tela lacks (a pinned post,
"Reads you too", named readers, removing a card), and its example card is the owner's live
`@hutusi` profile. Privacy and Terms state what the code does, and Tela being a personal,
non-commercial project, they name no operator address, country or governing law, minimum age or
notice period, and say nothing about closing or deleting an account.

## Consequences

- A returning visitor never sees the edge's render: their worker answers `/` with the plain
  shell, as it does for Discover. The render is for first visits, browsers without the worker, and
  link previews.
- Every navigation's background shell refresh fetches `/__tela/shell`, a static answer, not `/`,
  which would now run the Worker.
- An edition can be five minutes old at the edge. Its dates render in UTC there and in the
  reader's own zone once the SPA mounts.
- The member branch reads a cookie's name, not a session. Renaming the session cookie (a move to
  `__Host-`, 0036) must change this check in the same release.
- With JavaScript off, the visitor's language pill does nothing; the edge renders in the language
  the locale cookie or `Accept-Language` gives.
- A member whose device storage is empty (a private window that refuses IndexedDB, a first boot on a
  new database layout) can see the landing for one round trip before `/reading`. That is accepted.
- Playwright blocks service workers, so the move off `/` is held by `sw.test.ts` (a page rendered
  for a visitor is never kept as the shell) and by a run in real Chromium against `wrangler dev`
  across two builds.
- Deploys keep their order, tela-jobs, tela-api, then tela-web. A tela-web that lands first, or a
  tela-api rolled back, costs visitors the edition, not the page.
