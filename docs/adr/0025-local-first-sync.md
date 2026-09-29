# 0025 — Local-first sync: one seq cursor to pull, idempotent mutations to push

Status: accepted (2026-09-28): the protocol, which tela-api implements, and the reader built on it
(`apps/reader`). Supersedes 0016 (the render budget: nothing renders on the server per click any
more) and 0017 (the client-owned pane), keeping 0017's rule that the URL alone says which article
is open. Amends 0010: still no i18n routing and a locale cookie, now read by use-intl in the SPA
and by the edge renderer.

## Context

The owner's second goal is instant reading, from mainland China too. A mainland reader is served
from an overseas PoP without an ICP filing, so the round trip can be hidden but not removed: the
reader must not need it per click. Spike S5 measured the alternative: with a local store, the
list shows 35 ms after navigation and an article opens in 11–18 ms, while the first sync, about
700 ms from Vancouver, runs behind a list that has already rendered.

That needs a protocol a device can follow for years without the server remembering devices.

## Decision

**A cursor, not a device registry.** Every batch that writes a synced row bumps one counter and
stamps its rows with the new value (invariant 17). SQLite has one writer, so seq order is commit
order with no gaps, and a device's cursor is simply the last seq it has seen.

**Pull: `GET /api/v1/sync?cursor=`**, read in one batch: one snapshot of the database, whatever
commits meanwhile.

- What a member holds:
  - their own rows: profile, prefs, subscriptions, read and like states, recommendations,
    claims;
  - the shared rows of the feeds they subscribe to: feeds, sites, articles, titles in both
    launch languages, and body translations of those articles;
  - articles they liked or recommended, with those articles' feeds and sites, whatever they
    subscribe to now.
- Cursor 0 is a **snapshot**: the 30-day horizon (ADR 0009), with `reset` set.
- Any other cursor is a **delta**: rows with a seq above it.
  - A subscription newer than the cursor brings its feed's horizon whole, because those articles
    were written before the subscription and their seqs are below the cursor.
  - A resubscription's horizon brings the member's own read and like states for those articles,
    whatever their seq, because the device dropped them with the feed.
  - Unsubscribing is a subscription row with `deletedAt`; the feed stops flowing.
  - **Kept articles** (liked or recommended) belong to no feed the member need follow.
    - Their changes flow whatever the member subscribes to (others' likes move their counts).
    - An article that becomes kept arrives whole, with its feed and site.
    - The device holds an article only while its feed is subscribed or the member keeps it, and
      prunes the rest after every pull.
  - Hard deletes would travel as tombstones. None of Tela's writers hard-delete a synced row
    today: compaction drops only read states under a watermark, which the watermark already
    implies.
- **Pages** hold up to 1,000 rows per table and end on a seq boundary, never inside the rows one
  batch wrote. `more` says pull again at once. A batch larger than a page goes out whole rather
  than stalling; no writer produces one (the largest is a feed's 200-item cap).
- A **cursor ahead of the database** (restored from a backup) gets a snapshot.
- A **client older than `MIN_CLIENT`** (header `x-tela-client`) gets `409 upgrade`, so a cached
  app shell that has fallen behind reloads rather than misreading rows.
- **Every member call names the member** (header `x-tela-member`, protocol 2). Tabs of one browser
  share the session cookie, so a tab can still hold the account another tab signed out of. The
  rule is that nothing a tab does for account A is applied to, stored in, or shown from account
  B, and it is checked where each effect happens:
  - tela-api refuses any `/api/v1` member call whose header is not the session's member, a
    missing header included, with `409 account_changed`, and runs nothing. `/api/v1/me` is the
    exception: it is how a tab learns who is signed in.
  - The device's stored copy has one owner. Every write to it reads that owner inside the same
    IndexedDB transaction and writes nothing on a mismatch; readwrite transactions over the same
    store run one at a time across every tab, so a check made in a separate transaction first
    would be a race. The copy lives in a database of its own (`tela-2`): an earlier build's tab,
    still open or brought back by a rollback, checks nothing, and must never reach it. When one
    has run on the device since, the copy is unverified until the next claim, because a sign-out
    or sign-in there never reached it. Tabs boot side by side, so the mark goes down before the
    earlier build's copy is emptied and again after, and a copy is loaded only after both. Each
    mark is new, and a claim clears only the one that stood when its /me was asked: a mark set
    since may be about a sign-out that answer came before.
  - Only a 401 says nobody is signed in. A 5xx mid-deploy, a captive portal's page, a WAF's
    challenge or no network says nothing about the session: the tab shows the public side, keeps
    its copy and unsent changes, and asks /me again (after 2 s, doubling to 2 min, and at once
    when the browser comes back online or the tab into view). Every answer is acted on the same
    way, whichever question it answers (the boot, a retry or a sign-in): one that names another
    account than the page was showing loads a fresh page.
  - Signing out names the member too, in the request that ends the session, so a stale tab
    cannot end the session another tab started.
  - A tab that loses either check stops, forgets what it holds, and starts again from `/` as
    whoever is signed in. Its unsent changes go with it: applying them to the other account is
    the thing prevented.
  - A shell older than protocol 2 is told `409 upgrade` first, so cached shells from before the
    rule reload into one that follows it.
  (Amended on 2026-09-29, after review rounds found the mixes: first for sync, then for every
  other member call and every stored write, then for tabs booting together and a /me that
  failed.)
- Pulls read the D1 primary from the pinned Worker (6–10 ms). There is no read replication, so no
  Sessions bookmark and no read-your-writes gap to handle.

**The device** (`@tela/sync` client: `applyPull`, `applyMutation`, `view`, `settle`) holds two
things.
- **Confirmed:** tables folded from pulls.
- **Pending:** its own mutations.

It renders the confirmed tables with the pending replayed on top. A pending mutation is dropped
only once a push acknowledged it at seq N *and* a pull reached N, so an optimistic change never
flickers back to its old state in between.

**Push: `POST /api/v1/mutations`**, up to 50 in one batch, which lands whole or not at all.

- The mutations: `markRead`, `setLiked`, `markAllRead`, `subscribe`, `unsubscribe`, `setPref`,
  `setProfile`, `recommend`, `unrecommend`, and `putHighlight` and `deleteHighlight` (ADR 0026). Their zod schemas in `@tela/sync` are shared with the
  client.
- **A replay changes nothing.** Each carries a client-minted `mid`, every statement is guarded by
  that id not being in `applied_mutations`, and the id is recorded last. Kept 30 days.
- **Conflicts go to the later `at`**: likes, recommendations and prefs are absolute values with
  last-writer-wins. `at` is clamped to the server's clock, so a device with a clock in the future
  cannot win every argument.
- **`markAllRead` takes `upTo`, the highest id the client displayed.** The Postgres app used its
  own `max(id)` and marked read posts the reader never saw. The watermark never moves backwards
  and never past what exists.
- **A bad reference is a no-op.** Rows are written through `insert … select … where exists`, so a
  missing article writes nothing instead of a foreign-key error sinking the batch. Invalid
  mutations are refused one by one; the rest apply.
- Adding a feed by URL and requesting a translation are RPCs, not mutations: the reader needs the
  answer.

## The reader (`apps/reader`, tela-web)

A Vite + React SPA, served as static assets, whose every screen is a function of the local store
and the URL.

- **The store** (`src/store/local.ts`) holds the confirmed tables and the pending mutations in
  memory, renders their combination through `useSyncExternalStore`, and writes every change
  through to IndexedDB (`idb`). A pull rewrites only the tables it touched, where pruning counts
  as touching: an unsubscribe shrinks the articles table though no pulled row named them. Each
  pending mutation is a record of its own (`pending:<mid>` in `meta`), tagged with its owner, not
  one list: tabs share the database and each holds only its own list in memory, so one record let
  a tab's save erase another tab's unsent changes. A copy written before the stored copy had an
  owner is not trusted and starts over, unsent changes included. (Changed on 2026-09-29, after a
  review found it.)
- **When it talks** (`src/store/engine.ts`): a pull at boot, when the tab becomes visible, every
  60 s while it is, and after each push. A push goes a quarter-second after the last change, so a
  burst of reads is one request, and at once with `keepalive` when the tab is hidden or closed, so
  the last change before leaving is not left waiting for the next visit. 401 ends the session and
  wipes the device's copy while it is still this tab's; 409 `upgrade` reloads a newer shell, and
  409 `account_changed` (from any call) starts over from `/` as whoever is signed in now.
- **Bodies and translations** (`src/store/objects.ts`) come from memory, then IndexedDB, then the
  edge. While the reader is idle (1.5 s after the list settles) it prefetches unread bodies, the
  list on screen first, 25 to a `/o/bundle` request and two requests at a time, and then finished
  translations in the reading language. Nothing is prefetched under Save-Data. Read bodies are
  evicted after seven days, or once the store passes 50 MB.
- **Streamed translation** (ADR 0023): a foreign post asks for one when it opens. While it runs,
  the page polls its status every 1.5 s in a visible tab, fetches each chunk as the status names
  it, and lays it over the original by block index. The finished object replaces the chunks, and
  the synced row says so on every device.
- **The URL owns the open article** (0017's rule). With no server cache as a second owner, the
  settling logic 0017 needed is gone: Back, a filter change and an open are all renders.
- **Posts from outside the synced feeds** (a blog's public page, a profile's recommendations, a
  search hit past the horizon) arrive as full article rows and are held for the visit, so the
  reader opens them like any other.
- **Search** looks through the device first; the server adds older posts and blogs the member does
  not follow.
- **Public pages** (Discover, `/s/:id`, `/@handle`) are rendered by tela-web with the SPA's own
  views, from tela-api's public JSON. They are cached per colo, locale and deploy for five
  minutes, and their data is handed to the SPA in `#tela-data`.
- **The app shell** is cached by a service worker (`public/sw.js`): navigations get the cached
  shell at once and refresh it behind, and hashed assets are served forever. `/api`, `/o` and
  `/img` never pass through it, so offline reading is not something it pretends to do.
  `shell/kill-sw.js` replaces it when a bad shell has to go. A shell older than the protocol meets
  409, clears itself and reloads, at most once a minute.
- **Writes to `/api/*` must carry tela-web's origin.** Session cookies are `SameSite=Lax`, which
  leaves a sibling subdomain able to post with them. Hubs and the admin script, which authorize
  themselves, are exempt.

## Consequences

- **A device needs nothing from the server but its cursor**, and the server keeps nothing per
  device.
- **Every write path owns its seq stamp.** A writer that forgets `bumpSeq` makes its rows
  invisible to devices whose cursors have passed. The dead-letter path did exactly this; it is
  fixed and tested.
- **The pull is one batch of about twenty reads**, all by indexed `(…, seq)` or by primary key.
- **Convergence is tested against the real tela-api**, not a model of it. Seeded random histories
  mix local changes, pushes (a quarter of their responses lost), pulls, and articles the server
  writes meanwhile. After a final push and pull, the device must equal a fresh snapshot with
  nothing pending.
  - 12 seeds run in the suite; sweeps of 700 more with histories up to 250 steps pass.
  - The first sweep found the two gaps above: resubscribed feeds came back unread, and kept
    articles went stale or were never let go.
- **The tests that guard it**, each shown to fail when its rule is removed:
  - the replay guard, where `setProfile` is the one mutation last-writer-wins cannot protect;
  - last-writer-wins on likes;
  - the clock clamp;
  - the missing-reference no-op;
  - the page boundary. It runs on libSQL and on D1.
- **The reader is measured, not assumed, to need no network per click.** An e2e spec runs five
  opens, a filter change and Back after the first sync, and counts requests to `/api` and `/o`:
  there must be none. Another holds every sync call and reloads: the list must still render, from
  IndexedDB.
- **The client costs 127 KB gzipped** (React, React Router and use-intl are most of it). The
  mutation schemas stay out because `@tela/sync` is side-effect free. A repeat visit costs none
  of it, and the first sync runs behind a list that has already rendered.
- **Sign-in is a code or the mail's link** (ADR 0024), in the browser e2e too: there is no
  development back door to test around it.
