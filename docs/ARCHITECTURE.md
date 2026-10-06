# Tela architecture

Tela is a multi-user, multilingual reader for independent blogs whose identity is "every feed here
has a human behind it". This document is the living map of the system; decisions and their reasons
are in `adr/`. It describes the local-first stack (ADRs 0020–0029), which replaces the Postgres app
at the cutover in `docs/OPERATIONS.md`.

## Topology

```
Browser ──▶ tela-web (edge, unpinned): static SPA, public pages, /o/* objects, /img/*, /avatar/*, /api/* forward
              │ service binding
              ▼
            tela-api  (pinned aws:ap-southeast-1) ──┐
            tela-jobs (pinned aws:ap-southeast-1) ──┼──▶ D1 (primary in Singapore, 6–10 ms)
              ▲ crons: sweeps · upkeep+backup · digest └──▶ R2: tela-content (members, backups),
              │ queues tela-fetch/extract/translate/misc       tela-assets (public favicons)
              └── cron and queue handlers only call SELF.fetch(): placement pins fetch handlers
   tela-jobs ──▶ Bailian (translation) · Resend (mail) · healthchecks.io (dead-man's switch)
   apps/relay (Node, HK box, not provisioned until a feed needs it) ◀── signed POST /fetch
```

The reader never waits on that picture: every screen renders from the rows the device holds,
and a sync keeps them current behind it (ADR 0025).

## Monorepo

```
apps/reader       tela-web: the Vite + React SPA (src/) and the edge Worker (worker/)
apps/api          tela-api: Hono, better-auth, sync, every reader RPC
apps/jobs         tela-jobs: the sweeps, queue consumers, the Ingest RPC, upkeep, backups, digest
apps/relay        the China fetch relay, the one Node process (ADR 0008)
packages/platform the seams: Db, Blobs, Jobs, Clock, Mail; ./cloudflare and ./portable adapters
packages/data     the SQLite schema, migrations, leases, the sync sequence, queries, backups
packages/sync     the sync protocol: row types, pull response, mutation schemas, the reducer
packages/content  the content contract: sanitize, blocks, tagged text, hashing, objects
packages/ingest   fetching: HTTP client, discovery, the ingest pipeline, WebSub, relay client
packages/llm      translation adapter, prompts, output validation
packages/shared   constants: languages, topics, NORM_VERSION, limits, handles, invite codes
packages/config   shared tsconfig bases
```

Bun is the package manager, script runner and test runner; the Workers run on workerd and the
relay on Node 24 (ADR 0001). Only `packages/platform/src/cloudflare.ts` touches a binding, so
every app is built from interfaces and the suite runs it on libSQL, memory blobs and an in-process
queue (ADR 0021).

## Data model

One SQLite schema (`packages/data/src/schema/`), one migration history
(`packages/data/migrations`), applied to D1 by wrangler and to libSQL by the tests. Timestamps are
epoch milliseconds; arrays read whole are JSON text; every row a device syncs carries `seq`.

| Table | Role |
|---|---|
| `user`, `account`, `session`, `verification`, `rate_limit` | better-auth's, through its Drizzle adapter (ADR 0024). `account` is also unique on `(provider_id, account_id)`, which `auth generate` leaves out: better-auth refuses an identity it finds twice (ADR 0036) |
| `invite_codes`, `invite_redemptions` | Invite codes, not synced (ADR 0034). A code is a member's (`created_by`, one place) or the operator's (null, `max_uses` places), until `revoked_at`. A redemption is an address beside a code, or the operator's invitation to one address (code null): a hold until `redeemed_at`, lapsing at `expires_at` without taking a place, then a place for good, settled once the account it made exists (`user_id`, and `settled_at`, which outlives a deleted member). A claim never settled admits the same address again. A code's places are its redeemed rows; every claim is one statement (`packages/data/src/queries/invites.ts`) |
| `admin_actions` | What operators did in the admin console (ADR 0039), not synced: one row per target, with the group a request shares (the undo token), the actor, the action, the target, and `detail` holding `{from, to}`, read by an `insert … select` in the change's own batch. Never an email address |
| `profiles` | One per member: `handle`, `display_name`, `bio`, `ui_locale` and `reading_lang` (null follows the interface, ADR 0040), each with the `at` of the change that set it (`ui_locale_at`, `reading_lang_at`), whether the member shows their subscriptions and likes (`public_subscriptions`, `public_likes`, both off by default, each with the `at` of the change that set it and a version that every change counts up, which a show must name, issue #16), their picture (ADR 0032, 0033): the R2 key of one they uploaded (`avatar_key`), whether they show their Gravatar (`gravatar`, with its `gravatar_at`; never set counts as on), whether Gravatar has one for them (`gravatar_found`, asked at `gravatar_checked_at`), and `avatar_version`, the picture's version, which every change of picture counts up, and `is_admin`, who may open the admin console (granted only by the operator's token, ADR 0039) |
| `user_prefs` | Synced preferences, one row per key: reading mode, text size, measure, theme (`lib/typography.ts`), and the Reading and Translation settings `reader.mark_on_open`, `reader.hide_read`, `translate.auto`, `translate.never` (`lib/prefs.ts`) |
| `sites` | A blog: normalized `home_url`, `listing` (private/listed/featured/rejected), `claimed_by`, `reader_count`, `translation_opt_out`, and an operator's review for Discover (ADR 0041, neither synced): what it decided (`review`, listed or dismissed; null keeps a blog a member added in the review queue, and `listed` keeps a blog in Discover through an Unfeature or a removed claim) and when the last decision was made (`reviewed_at`) |
| `site_topics`, `site_claims` | A blog's topics; claim attempts (meta or `rel="me"`), with the operator who vouched for one (`vouched_by`, so its check skips only the proof) and when an operator last decided on it (`reviewed_at`, ADR 0039) |
| `feeds` | The fetch unit: validators, schedule (`next_fetch_at`, `fetch_interval_sec`), `fetch_region`, `timeout_streak`, `status`, `content_mode`, `hub_url`, `merged_into` (another address for the blog's canonical feed, ADR 0028) |
| `articles` | `dedup_key` unique per feed, `sort_at`, `source_lang`, `current_version`, `content_key`, `extract_state`, counts. `AUTOINCREMENT` ids, so the unread watermark never meets a reused id |
| `article_versions` | Every body an article has had: provenance (feed or readability), `content_key`, `raw_key` (ADR 0022) |
| `article_titles` | Eager title and excerpt per launch language: `done`, `echo` or `failed` against the title hash |
| `block_translations` | The content-addressed block cache: source hash × target language × `NORM_VERSION` |
| `body_translations` | A body per content version and language: state, reservation, streamed `chunk_keys`, the finished object (ADR 0023) |
| `subscriptions` | `(user_id, feed_id)` with `watermark_id`: everything at or below it is read (ADR 0009) |
| `user_article_states`, `recommendations`, `highlights` | The member's read and like state (a row with `read_updated_at` and no `read_at` is marked unread, which beats the watermark and the horizon until a later read; compaction keeps every row with that clock, ADR 0009), public recommendations with notes, private highlights with notes (ADR 0026) |
| `follows` | `(follower_id, followee_id)`: one member following another, one-way and public, soft-deleted, synced to the follower (ADR 0031) |
| `websub_subscriptions` | One per feed with a hub: topic, secret, status, lease |
| `leases`, `lease_fence` | Who holds which piece of background work, and the fence that aborts a stale holder's batch |
| `dead_letters`, `ops_heartbeats` | Work that gave up, until an operator retries or dismisses it (`resolved_at`, `resolution`, `resolved_by`); the last `tick`, `health`, `daily` and `digest` runs, the tick's with the switches tela-jobs runs with (ADR 0039) |
| `llm_calls`, `usage_daily` | Every model call, with the feed it was for (`feed_id`); reserved and used tokens per member and day (`'*'` is background) |
| `action_limits`, `applied_mutations`, `tombstones`, `counters` | Reader action limits, and sign-in limits per email address; pushed mutation ids (replays change nothing); hard deletes for sync; the `seq` counter |

## Content pipeline

`packages/content`, pure TypeScript with no I/O (normative spec: `packages/content/README.md`):

1. Discovery (`findFeedLinks`, `candidateFeedUrls`): `link[rel=alternate]`, feed-looking anchors,
   then well-known paths.
2. Parsing (`parseFeedText`) with `feedsmith`: RSS, Atom, RDF, JSON Feed → `ParsedFeed` with
   `summaryHtml` and `contentHtml` per item.
3. Sanitize (`sanitizeArticleHtml`) with an allowlist; links and images absolutized; lazy-load
   attributes folded into `src`; tracking pixels dropped.
4. Normalize + annotate (`annotateBlocks`): wrappers unwrapped, inline runs wrapped, every
   text-bearing element a leaf with a `data-tb` id = first 10 hex of
   `sha256(normalized tagged text + NORM_VERSION)`, duplicates suffixed by position.
5. Tagged text (`toTaggedText` / `fromTaggedText` / `checkPlaceholders`): inline markup becomes
   `<gN>…</gN>` and `<xN/>` placeholders; rehydration re-escapes model output.
6. Skip `pre` and blocks with no letters or under two characters (`data-tb-skip`).
7. `detectLanguage` (script ratios, then eld, with the blog's language breaking near ties), `makeExcerpt`, `readingMinutes`.
8. **The content object** (`object.ts`, ADR 0022): the annotated body split into top-level blocks
   with their leaf ids, images indexed so `/img/<key>/<i>` can serve them, keyed by the hash of
   the annotated HTML. Immutable, so it is cached forever everywhere. `extractArticle` (Readability
   on linkedom) recovers full text for summary-only feeds. It first drops what a browser never
   shows as the post (`<template>` link previews, webmention and backlink containers), and it
   refuses a result that is 70% link text or more (a site menu) or has under 100 characters.

Fixtures: 21 captured real feeds in `packages/content/fixtures/`; snapshot tests pin block ids
and hashes as the `NORM_VERSION` contract.

## Ingestion (`packages/ingest`, run by tela-jobs)

- `createHttpClient`: conditional headers, manual redirects with permanent-redirect detection,
  a 5 MB cap, charset-aware decoding, private-network refusal, and the relay hook for
  `fetch_region = 'cn'`. One abort signal per request, not per redirect hop.
- `ingestFeed` (`pipeline/feed.ts`) runs a whole fetch under the feed's lease: conditional GET,
  relay flip, alias detection, provenance and declared-home adoption, the 200-item cap,
  content-mode learning, scheduling. Everything commits in one fenced batch, so two fetches of one
  feed cannot interleave (the lease is the per-feed serialization).
- One blog, one feed (`pipeline/merge.ts`, ADR 0028): before fetching, a feed whose blog has
  other active feeds checks whether it holds the same post URLs as one of them over the time
  both cover. If it does and the other is canonical (on the blog's own host, else older), it
  pauses itself with `merged_into`, moves its readers, the posts only it had and their titles,
  translations and read states across, and stops. Adding, importing or subscribing to a merged
  feed lands on its target.
- Scheduling: interval = half the average gap between posts over 7 days, clamped to 30 min…24 h,
  ×1.5 when unchanged, raised to the publisher's `ttl`/`max-age`; ±10% jitter on the derived
  `next_fetch_at` only. Errors back off `interval × 2^n` up to 7 days; 429/503 honour
  `Retry-After`; 410 or 30 consecutive errors mark a feed dead, and the nightly upkeep revives it
  after a week.
- Versions: `chooseCurrent` decides which body readers see. A summary feed's current version is
  its latest Readability extraction, so a changed summary asks for a new extraction instead of
  replacing the full text.
- `extractArticleJob`, `siteAssetsJob` (raster favicons to `tela-assets`), `verifyClaimJob`
  (meta or `rel="me"`, then provenance), `websubSubscribeJob`, and `gravatarCheckJob`
  (`pipeline/gravatar.ts`: whether Gravatar has a picture for a member, recorded and never copied,
  ADR 0033).
- `createIngest` (`pipeline/rpc.ts`) is what tela-api reaches over the `Ingest` RPC: discovery,
  adding a feed, starting a claim, reading OPML. The parsers never enter tela-api's bundle.
- `relay.ts` is the relay client (HMAC-SHA256 over a timestamp and the body); `region-policy.ts`
  flips a feed to the relay on its third consecutive timeout while the control URL answers.

## Background work (`apps/jobs`)

- `src/kinds.ts` is the one table of background work: for each kind, the due query over a domain
  row, the lease length, backoff, queue, handler, what exhaustion writes, and whether it is enabled.
- `tick` (every minute) claims each kind's due work under a lease and sends it to its queue;
  `runJob` takes the claim over under its own owner (counting the attempt before any work, and
  leaving nothing for a second delivery of the message to start), does the item, and never
  throws: a failure backs the lease off, and exhaustion dead-letters it. After a success it claims
  the next due item on the same host, two seconds later, so a backlog drains without waiting for
  ticks while each host still sees one request at a time.
- The cron and queue handlers only call `SELF.fetch()`, whose handler placement pins beside D1.
- Nightly (`17 3 * * *`): upkeep in one batch (relay re-probes, dead-feed revival, pruning,
  compacting read state under watermarks, `compactReadStates`, which keeps any row that ever held
  a like or a read or unread chosen by hand), then the export and its verification (`backUp`).
  The pruning takes old limits and
  mutation ids, and personal data with no further use: invite holds a day past their expiry,
  ended sessions, better-auth's counters after a day, and spent sign-in codes and OAuth states.
- Mondays (`0 8 * * 1`): the digest, which also counts Discover's review queue (`DISCOVER_REVIEW`
  in `@tela/data`, the console's predicate, ADR 0041). Every five minutes after the tick: the
  health check and the dead-man's ping (`src/ops.ts`). The health check itself is `health()` in
  `@tela/data`, so the admin console asks it too; it counts only dead letters nobody has
  resolved.
- Every run leaves a heartbeat in `ops_heartbeats`: `tick` (each kind dispatched, and its
  `config`: the background budget, the article cap, whether a translator, the relay, WebSub and
  the assets bucket are configured), `health`, `daily` and `digest`. tela-api reads the budget
  and the relay there rather than from a second copy of the configuration.
- `REDUE` (`@tela/data`) says, per kind, how a dead item is made due again: the admin console's
  Retry runs it with the dead letter's resolution in one batch, and the next tick claims the item
  with fresh attempts.
- `src/portable.ts` runs the same tick and jobs on a timer with an in-process queue: the exit path,
  and what the test-mode `cycle()` uses.

## Translation (`packages/llm`, `apps/jobs/src/translation`)

- `packages/llm` is the adapter: a `Translator` interface over Bailian (GLM), Anthropic and a
  deterministic mock. `translateBlocks` validates every block (placeholder multiset, length ratio,
  non-identity) and retries failures once in strict mode.
- **Titles, eager** (`translate.title`, keyed by feed): the sweep finds feeds with articles whose
  current title hash has no row in some reading language (`READING_LANGUAGES`: `zh-Hans`, `zh-Hant`, `en`, `fr`); a job translates up to 20 titles and
  excerpts of one feed per call per language, and commits each (language, source) group in its
  own fenced batch as it lands. The background budget (`usage_daily` subject `'*'`)
  stops the sweep for the day once spent.
- **Bodies, lazy and streamed** (`translate.body`, ADR 0023): opening a foreign post reserves
  against the member's day and claims the work at once. Groups follow top-level block boundaries,
  about 400 source tokens first and then about 3k; each lands as a chunk object
  `tc/<key>/<lang>/<request>/<n>.json`, committed in a fenced batch with its cache rows and call
  log, and the reader lays it over the original by block index. The finished object is
  `t/<key>/<lang>/<sha>.json`.
- The block cache is content-addressed and shared by titles and bodies; a title echo never enters
  it.
- **Traditional Chinese is converted, never translated** (ADR 0038). The model is only ever asked
  for Simplified; `packages/llm/src/zh-script.ts` (OpenCC, Taiwan phrasing) converts. Between the
  two scripts a title or body is converted from the source, with no call, usage or reservation
  (`apps/jobs/src/translation/scripts.ts`, `planFor`). From any other language, titles group by
  what the model writes, so one Simplified call writes both Chinese rows, and a Traditional body
  is written and cached as Simplified and converted on the way out. The block cache holds only
  model output; a conversion is never stored there. Simplified and Traditional requests for one
  body that overlap each pay for the same blocks, a known cost (ADR 0038).

## API (`apps/api`, ADR 0024)

tela-api is Hono, built by `createApp(deps)` from portable dependencies.

| Route | Purpose |
|---|---|
| `/api/auth/*` | better-auth, only the endpoints Tela uses (`AUTH_ENDPOINTS` in `src/app.ts`, ADR 0036) and the guarded sign-out; every other is a 404 before better-auth sees it. Email codes, hashed, three tries; an account is made at an address's first code sign-in, only by claiming an invitation it holds, and a code is mailed to no address with neither an account nor an invitation (ADR 0034). Passwords (scrypt, 10–128 characters) are set only on a member a code has proved and never at sign-up; a forgotten one is reset by a code of its own, which ends every session (ADR 0036). Google and GitHub, each once its app is configured, ask for an address only: a new account only by the invite code its start carried, checked there and handed to the callback in the OAuth state; a provider is linked to a member only explicitly, never by a matching address; no token, name or picture is kept, and the address is mailed a notice. Limited per IP by better-auth and per email address by Tela (`action_limits`) |
| `POST /api/admin/invite`, `POST /api/admin/curate` | Bearer `ADMIN_TOKEN`: invite a member (the operator's invitation to the address, then the account, through the same gate as every other); add and feature a curated blog |
| `POST`, `GET /api/admin/codes`, `DELETE /api/admin/codes/:code` | Bearer `ADMIN_TOKEN`: the operator's invite codes (ADR 0034), text of their choosing that no member code's shape matches, with up to 100,000 places; listed with places taken and live holds; revoked whether used or not, which cancels its holds and keeps who joined |
| `POST /api/v1/join` | A visitor's join with an invite code, no session (ADR 0034): a day's hold beside the code, which takes no place, then a sign-in code that says the address is invited, in the joiner's language (only their `tela_locale` cookie and Accept-Language are passed on to better-auth). An address with an account gets a plain code and leaves the code alone, with the same 200. 400 `invalid_code` (unknown or revoked, one answer), 409 `code_used`. It mails through `auth.api`, which better-auth's limiter never counts, so it counts its own in `action_limits`: per IP (an IPv6 /64) before it looks the code up; then, for a live code only, per address (with the sign-in codes mailed to it) and per code (its places an hour, at least 20) |
| `GET`, `POST /api/v1/invites`, `DELETE /api/v1/invites/:code` | A member's five codes (ADR 0034), live answers like the dashboard, not synced rows: the codes that count (unrevoked, or used) and who joined with each, by handle, never a pending address; a new one while fewer than five count; revoking an unused one frees its place and cancels its holds |
| `GET /api/v1/account`, `POST /api/v1/account/password`, `/link`, `/unlink`, `/sign-out-everywhere` | A member's ways in (ADR 0036), live answers, not synced rows: their address, whether they have a password, the providers linked, and whether the session is fresh (made within the day); the first password set on a fresh session, or changed given the current one; Google or GitHub linked from a fresh session, returning to `/settings?linked=<provider>` or `/settings?error=<code>`, URLs fixed on the server, and written at the return only for a browser that still holds a live session of the member's; a provider unlinked on a fresh session (a password is not removed); every other session ended. Every call reads the session from D1 again, not its signed copy. A password set or changed, or a provider linked (at its return), ends the member's other sessions; every change, and a reset by code, mails the member a notice. Counted per member: passwords 5 per 15 minutes, links and unlinks 10 an hour each |
| `GET /api/v1/sync?cursor=` | The pull: a horizon snapshot at cursor 0, deltas by seq in pages ending on a seq boundary |
| `POST /api/v1/mutations` | The push: up to 50 idempotent, last-writer-wins mutations in one batch |
| `/api/v1/translations` | Request a body translation; poll its streamed state |
| `/api/v1/feeds` | Discover feeds at a URL, add one, import and export OPML |
| `/api/v1/claims` | Start a claim, see its proofs, ask for the check |
| `/api/v1/profile`, `/api/v1/sites/:id/*`, `/api/v1/dashboard`, `/api/v1/search` | Handle and profile, owner-only topics and opt-out, the author dashboard, search past the device's horizon |
| `GET /api/v1/following`, `GET /api/v1/sites/:id/followed-readers` | What the people a member follows recommended, liked and subscribed to, thirty entries a page behind a (time, offset, key) cursor, a day's likes grouped and placed at the newest, with readers to follow; which of them read a blog. Only as far as each shows it (ADR 0031) |
| `GET /api/v1/export` | "Your data": the member's own rows as one JSON file |
| `GET /api/v1/public/auth` | Which providers the sign-in sheet may offer, `{google, github}`: each once its app is configured (ADR 0036) |
| `/api/v1/public/*` | Discover, a blog's page (with its claimant and readers' notes), a profile (with follow counts, and liked posts only if shown): listed and featured blogs only, edge-cacheable. A blog's reader count is given from three readers and is null below, in Discover's order as well as its value (`publicReaderCount`, ADR 0041); member search gives it the same way |
| `GET /api/v1/public/avatars/:userId?v=` | A member's picture, only at the version it is at (ADR 0032, 0033): the one they uploaded, from R2, else their Gravatar while they show it and the check found one, fetched here by the hash of their email, which never leaves tela-api; raster types only, 512 KB, immutable for 30 days; none is a 404 the letter stands in for |
| `GET /api/v1/public/front` | The front page's edition (ADR 0035): each public blog's newest post, newest first, from the last seven days, or the latest ones when nobody wrote that week, eleven at most, with its titles and translated excerpts, its blog and its claimant; and the counts the copy states, public blogs and the week's distinct blogs, languages and posts. Each blog's newest post is one seek per live feed down `articles_feed_sort_idx`; future-dated posts wait. Cached as a profile is |
| `GET /api/v1/public/handles/:handle` | Whether a handle is free, for For writers' card as it is typed: `invalid`, `reserved`, `taken` or `available` (by `@tela/shared`'s rules, read lowercase), and the first free one among it, it plus a digit and it plus `_writes`. `no-store`; a valid shape is counted per IP (`handleCheck`, 300 an hour) |
| `PUT`, `DELETE /api/v1/avatar` | A member's own picture (ADR 0033): its bytes say what it is (PNG, JPEG or WebP, square, 64–1024 px, 512 KB), kept in R2 `tela-content` under `avatars/<userId>/<random id>.<ext>`, a key never used twice, so a deletion can only take the object its own change replaced; the body is read no further than 512 KB, and twenty an hour are counted before any is read; each change moves the version and deletes the object it replaces |
| `POST /api/admin/admins` | Bearer `ADMIN_TOKEN`: open or close the admin console to a member (`profiles.is_admin`, ADR 0039); only the token grants it |
| `/api/v1/admin/*` | The admin console (ADR 0039), for a member with `is_admin`, read from D1 on every call past the signed session copy: `counts` and `overview`; `claims`, `sites`, `feeds`, `discover`, `people`, `invites`, `translation` and `system` as filtered, searched lists (500 rows at most; People and Invitations take a search as a POST body, since it is often an email address and a URL reaches the Workers' logs) and their records; `translation/report` and `system/report`; `POST act` (an action on up to 50 targets, each its own audited batch) and `POST undo` (a group restored only while every target still holds what the action wrote). Under `/api/v1`, never `/api/admin`, so its writes are held to the same origin |
| `/api/websub/:feedId` | The hub callback: intent checks, and signed pings that make the feed due |
| `/api/health` | Liveness and D1 latency |

Every `/api/v1/*` route but the public ones and `/api/v1/join` needs a session, read from the
signed five-minute cookie cache; `/api/v1/account/*` reads it from D1 again, so a session ended
elsewhere changes nothing there. Reader actions are rate-limited per member (`action_limits`).

## The edge (`apps/reader/worker`, tela-web)

The only public Worker, unpinned, with no D1.

- `/api/*` goes to tela-api; a write must carry this origin (hubs and the admin script exempt).
- `/o/c|t|tc/…` and `/o/bundle` serve immutable objects from R2 to members, cached per colo after
  the session check; raw HTML (`r/`) and backups are never served.
- `/img/<contentKey>/<i>` proxies the image the content object names: the object is the
  allowlist. Raster types only, no SVG, 10 MB, cached for seven days.
- `/avatar/<userId>?v=<n>` is a member's picture (ADR 0032), from tela-api's
  `/api/v1/public/avatars/:userId`, cached per colo for as long as tela-api says (30 days for a
  picture, since the version is in the address). Public, and it asks tela-api nothing for an
  address that names no member or version.
- Sessions come from the signed cookie cache; when it has lapsed, tela-api's get-session is asked
  and its fresh cookie passed on.
- `/discover`, `/s/:id` and `/@handle` are rendered here (`src/ssr.tsx`) with the SPA's own views,
  from tela-api's public JSON, into the built `index.html`, cached per colo, locale and deploy for
  five minutes, with the data handed to the SPA in `#tela-data`.
- `/` is the front page (ADR 0035), rendered the same way for visitors from
  `/api/v1/public/front`, one page for each title mode (`?titles=translated`), and from its own
  key, never the address asked. A request whose cookie holds `tela.session_token` is a member's:
  the plain shell from the assets, before the cache lookup, with no call to tela-api, never
  cached. Any answer but a 200 from tela-api, a 404 included, is the plain shell, uncached, never
  a 404 page at `/`; so is a call that throws or takes more than three seconds, body included
  (`PAGE_DEADLINE_MS`), on every public page: a slow D1 never keeps a page blank. Every browser response for `/` carries `Vary: cookie`; the colo's copy
  carries none (workerd ignores Vary), since only a visitor's copy is stored. A test
  (`apps/reader/test/routes.test.ts`) holds every public page to `run_worker_first`.
- `/about`, `/privacy` and `/terms` are rendered the same way from the bundle alone: their route
  has `api: null`, so the edge asks tela-api nothing and hands nothing over (ADR 0035).
- Everything else is the SPA's static assets, which answer without running the Worker. A path
  with no file is answered 200 with `index.html`, a missing `/assets/*` script included:
  `run_worker_first` is a list, and then the fallback applies to every request, not only
  navigations.

## The reader (`apps/reader/src`, ADRs 0025, 0026)

A Vite + React SPA that renders from the device.

- `store/local.ts` holds confirmed rows and pending mutations, written through to IndexedDB, one
  record per pending mutation so that tabs sharing the database never erase each other's.
- `store/engine.ts` pulls at boot, on focus, every minute and after a push. It pushes a
  quarter-second after a change, and at once (`keepalive`) when the tab hides.
- `store/objects.ts` serves bodies and translations from memory, then IndexedDB, then `/o/*`,
  downloading each once however many ask while it is on its way. It prefetches unread bodies
  while idle, and evicts bodies not opened for seven days, and the oldest past 50 MB.
- `store/selectors.ts` answers the reading view: unread, lists, counts, the title to show.
- The URL alone says which article is open (ADR 0017's rule, kept): a click, a filter change or
  Back is a render, not a request.
- `views/` are the front page, Discover, a blog's page, a profile and the info pages as pure
  components the edge renders too. `/` renders the front page while the session is unknown on a
  device that holds no account, so the edge's copy is never replaced by a blank page.
- Highlights: `lib/anchor.ts` finds a highlight again by leaf, quote and context;
  `lib/use-highlights.ts` paints them over the rendered text with the CSS Custom Highlight API and
  writes back an anchor the post moved. Typography and theme are synced prefs
  (`lib/typography.ts`); which panes show is this device's, in localStorage (`lib/layout.ts`,
  ADR 0029). `j`/`k`/`Esc`/`o`/`l`/`m`/`h`/`[`/`f`/`?` work on `/reading`.
- `public/sw.js` caches the app shell only, and swaps to a new shell only once every file it
  loads is cached; `shell/kill-sw.js` replaces it in an emergency. It fetches the shell from
  `/__tela/shell`, a path tela-web never runs for, because `/` is the landing the edge renders
  for visitors (ADR 0035), and keeps it under `/` only if it is the plain shell: an empty
  `#root`, and no `#tela-data`.
- `public/manifest.webmanifest` makes Tela installable. It opens `/reading`, standalone, rather
  than `/`, which is two pages and runs tela-web; `/reading` is always the shell. The manifest and
  its three PNG icons are plain static assets, outside `run_worker_first`, and `sw.js` does not
  keep them: its icon branch keeps any 200, and a missing file's 200 is the app's HTML.

| Route | Purpose |
|---|---|
| `/`, `/?titles=translated` | The front page for visitors (ADR 0035), rendered at the edge: the count of public blogs, this week's edition (one post a blog; the latest when the week has none), titles as written or in the reader's language; members go to `/reading` |
| `/login` | Email code; the mail's sign-in and reset links fill their code in and ask before using it (ADR 0036) |
| `/reading?filter=&feed=&article=&mode=` | Sidebar, list and the open article |
| `/discover?topic=&lang=`, `/s/:id`, `/@handle?tab=` | Public pages, rendered at the edge too; a profile's tabs are cached apart |
| `/about`, `/privacy`, `/terms` | The info pages, for anyone; copy from `src/content/info`, rendered at the edge too, with no data |
| `/following?tab=` | What the people a member follows did, by RPC; whom they follow, from the device (ADR 0031) |
| `/search?q=` | The device first, then blogs and older posts from the server |
| `/add`, `/claim?url=&taken=`, `/sites/:id/claim` | Add feeds and OPML; claim a blog (For writers' card lands on `/claim` with its blog filled in) |
| `/writers` | For writers: a calling card made as you type, beside a labelled sample (ADR 0037); SPA-only (ADR 0035) |
| `/settings/:section?` | Profile, Reading, Translation, Subscriptions (with OPML in and out), Privacy (with "Your data"); Invites and Account read `/api/v1/invites` and `/api/v1/account` live, not synced rows (`lib/account-api.ts`) |
| `/dashboard` | The author's view |
| `/admin/:area?f=&q=&id=&sort=&dir=` | The admin console (ADR 0039), its own chunk loaded only when an admin opens it, reading tela-api over the network; anyone else sees Not found. The URL alone holds the area, filter, search, open record and sort |

## Sync (`packages/sync`, `packages/data/src/queries/sync.ts`, `apps/api/src/sync`, ADR 0025)

- One `seq` counter: every batch that writes a synced row bumps it and stamps its rows, so a
  device's cursor is simply the last seq it saw, and the server keeps nothing per device.
- The pull reads a member's own rows and the shared rows of the feeds they follow, plus the
  articles they keep (liked, recommended, highlighted), in one batch. The members they follow
  come as their own rows, re-sent when a followee's profile changes; what those members do does
  not sync at all, and arrives by RPC (ADR 0031).
- The push is guarded per mutation by `applied_mutations` and resolves conflicts by the later
  `at`, clamped to the server's clock. The privacy switches are the exception: a hide always
  applies, and a show only against the version it was made against (ADR 0031, issue #16).
- Every member call names the account the device's rows belong to (`x-tela-member`, protocol 2).
  tela-api answers `409 account_changed` when it is missing or not the session's member, and the
  device's stored copy (IndexedDB `tela-2`, apart from earlier builds' `tela`) has one owner
  that every write checks inside its own IndexedDB transaction; signing out is checked the same
  way. So a tab that another tab signed out of neither mixes two accounts, nor applies
  one's changes to the other, nor writes one's rows into the other's copy (ADR 0025).
- The device's reducer (`packages/sync/src/client.ts`) is the same code in the browser and in the
  convergence test that runs it against the real tela-api.

## Safeguards

- **Batch-only SQL, fenced by leases:** anything decided in JavaScript commits as a batch whose
  first statement aborts it if the lease was lost, so a stale holder writes nothing.
- **D1's limits held everywhere:** 100 bound parameters, 100 KB of SQL, five compound terms. The
  portable client enforces them, so a test trips them before D1 does.
- **Outbound fetches** refuse private ranges by name and address; on Cloudflare
  `global_fetch_strictly_public` refuses them at the socket too.
- **Model output is never trusted as HTML:** placeholders must match, text is re-escaped.
- **Every new account claims an invitation:** better-auth's `user.create.before` admits a user only
  by claiming, in one statement, an invitation its address holds, or on a provider's return the
  invite code its start carried and nothing else, refuses by throwing, and treats a missing endpoint
  context as no permission at all (ADRs 0034, 0036). A sign-in writes whatever making
  the account missed: the profile, and the invitation's settlement.
- **Knowing it runs:** the dead-man's switch, the Monday digest, a verified nightly export, and
  D1's Time Travel (`docs/OPERATIONS.md`).
- **An operator's change beats the work in flight:** the admin console's pause, region, claim
  rejection, removal and vouch delete the item's lease in their batch, so a job already running
  finds its fence refused and writes nothing over the choice (ADR 0039).
- **Every operator change is audited and undone only if nothing moved since:** the audit row is
  read in the change's own batch, and an undo's guards abort its batch through `lease_fence` when
  any target changed after the action.
- **A small count is not published:** below three readers a blog's public count is null, and
  Discover orders it as none, so neither the number nor the order names who reads a blog an
  operator listed from the review queue (ADR 0041).

## Tests

- `bun run test`: every package and app on the portable adapters (libSQL in memory, memory blobs
  and queues), including the convergence property test, the backup round trip that restores and
  serves from a fresh database, and the edge Worker with a fake cache.
- `bun run test:workers`: the data contract and tela-api's sign-in, push and pull on real D1 in
  workerd.
- `bun run e2e` (`apps/reader/e2e`): the built reader, tela-api and tela-jobs in one `wrangler dev`
  on fresh local D1, R2 and queues, against the fixture feed server. Test mode (`ENV=test`) adds
  the sign-in outbox and `POST /api/test/cycle`, which runs tela-jobs' sweeps to completion,
  because local dev fires no crons.
