# Tela architecture

Tela is a multi-user, multilingual reader for independent blogs whose identity is "every feed here
has a human behind it". This document is the living map of the system; decisions and their reasons
are in `adr/`. It describes the local-first stack (ADRs 0020–0029), which replaces the Postgres app
at the cutover in `docs/OPERATIONS.md`.

## Topology

```
Browser ──▶ tela-web (edge, unpinned): static SPA, public pages, /o/* objects, /img/*, /api/* forward
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
packages/shared   constants: languages, topics, NORM_VERSION, limits
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
| `user`, `account`, `session`, `verification`, `rate_limit` | better-auth's, through its Drizzle adapter (ADR 0024) |
| `profiles` | One per member: `handle`, `display_name`, `bio`, `ui_locale`, `reading_lang`, and whether the member shows their subscriptions and likes (`public_subscriptions`, `public_likes`, both off by default, each with the `at` of the change that set it) |
| `user_prefs` | Synced preferences, one row per key: reading mode, text size, measure, theme (`lib/typography.ts`), and the Reading and Translation settings `reader.mark_on_open`, `reader.hide_read`, `translate.auto`, `translate.never` (`lib/prefs.ts`) |
| `sites` | A blog: normalized `home_url`, `listing` (private/listed/featured/rejected), `claimed_by`, `reader_count`, `translation_opt_out` |
| `site_topics`, `site_claims` | A blog's topics; claim attempts (meta or `rel="me"`) |
| `feeds` | The fetch unit: validators, schedule (`next_fetch_at`, `fetch_interval_sec`), `fetch_region`, `timeout_streak`, `status`, `content_mode`, `hub_url`, `merged_into` (another address for the blog's canonical feed, ADR 0028) |
| `articles` | `dedup_key` unique per feed, `sort_at`, `source_lang`, `current_version`, `content_key`, `extract_state`, counts. `AUTOINCREMENT` ids, so the unread watermark never meets a reused id |
| `article_versions` | Every body an article has had: provenance (feed or readability), `content_key`, `raw_key` (ADR 0022) |
| `article_titles` | Eager title and excerpt per launch language: `done`, `echo` or `failed` against the title hash |
| `block_translations` | The content-addressed block cache: source hash × target language × `NORM_VERSION` |
| `body_translations` | A body per content version and language: state, reservation, streamed `chunk_keys`, the finished object (ADR 0023) |
| `subscriptions` | `(user_id, feed_id)` with `watermark_id`: everything at or below it is read (ADR 0009) |
| `user_article_states`, `recommendations`, `highlights` | The member's read and like state, public recommendations with notes, private highlights with notes (ADR 0026) |
| `follows` | `(follower_id, followee_id)`: one member following another, one-way and public, soft-deleted, synced to the follower (ADR 0031) |
| `websub_subscriptions` | One per feed with a hub: topic, secret, status, lease |
| `leases`, `lease_fence` | Who holds which piece of background work, and the fence that aborts a stale holder's batch |
| `dead_letters`, `ops_heartbeats` | Work that gave up; the tick's last run |
| `llm_calls`, `usage_daily` | Every model call; reserved and used tokens per member and day (`'*'` is background) |
| `action_limits`, `applied_mutations`, `tombstones`, `counters` | Reader action limits; pushed mutation ids (replays change nothing); hard deletes for sync; the `seq` counter |

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
  (meta or `rel="me"`, then provenance), `websubSubscribeJob`.
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
  a like), then the export and its verification (`backUp`).
- Mondays (`0 8 * * 1`): the digest. Every five minutes after the tick: the health check and the
  dead-man's ping (`src/ops.ts`).
- `src/portable.ts` runs the same tick and jobs on a timer with an in-process queue: the exit path,
  and what the test-mode `cycle()` uses.

## Translation (`packages/llm`, `apps/jobs/src/translation`)

- `packages/llm` is the adapter: a `Translator` interface over Bailian (GLM), Anthropic and a
  deterministic mock. `translateBlocks` validates every block (placeholder multiset, length ratio,
  non-identity) and retries failures once in strict mode.
- **Titles, eager** (`translate.title`, keyed by feed): the sweep finds feeds with articles whose
  current title hash has no row in some launch language; a job translates up to 20 titles and
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

## API (`apps/api`, ADR 0024)

tela-api is Hono, built by `createApp(deps)` from portable dependencies.

| Route | Purpose |
|---|---|
| `/api/auth/*` | better-auth: email codes only, registration closed, codes hashed, three tries |
| `POST /api/admin/invite`, `POST /api/admin/curate` | Bearer `ADMIN_TOKEN`: invite a member; add and feature a curated blog |
| `GET /api/v1/sync?cursor=` | The pull: a horizon snapshot at cursor 0, deltas by seq in pages ending on a seq boundary |
| `POST /api/v1/mutations` | The push: up to 50 idempotent, last-writer-wins mutations in one batch |
| `/api/v1/translations` | Request a body translation; poll its streamed state |
| `/api/v1/feeds` | Discover feeds at a URL, add one, import and export OPML |
| `/api/v1/claims` | Start a claim, see its proofs, ask for the check |
| `/api/v1/profile`, `/api/v1/sites/:id/*`, `/api/v1/dashboard`, `/api/v1/search` | Handle and profile, owner-only topics and opt-out, the author dashboard, search past the device's horizon |
| `GET /api/v1/following`, `GET /api/v1/sites/:id/followed-readers` | What the people a member follows recommended, liked and subscribed to, thirty entries a page behind a (time, offset, key) cursor, a day's likes grouped and placed at the newest, with readers to follow; which of them read a blog. Only as far as each shows it (ADR 0031) |
| `GET /api/v1/export` | "Your data": the member's own rows as one JSON file |
| `/api/v1/public/*` | Discover, a blog's page (with its claimant and readers' notes), a profile (with follow counts, and liked posts only if shown): listed and featured blogs only, edge-cacheable |
| `/api/websub/:feedId` | The hub callback: intent checks, and signed pings that make the feed due |
| `/api/health` | Liveness and D1 latency |

Every `/api/v1/*` route but the public ones needs a session, read from the signed five-minute
cookie cache. Reader actions are rate-limited per member (`action_limits`).

## The edge (`apps/reader/worker`, tela-web)

The only public Worker, unpinned, with no D1.

- `/api/*` goes to tela-api; a write must carry this origin (hubs and the admin script exempt).
- `/o/c|t|tc/…` and `/o/bundle` serve immutable objects from R2 to members, cached per colo after
  the session check; raw HTML (`r/`) and backups are never served.
- `/img/<contentKey>/<i>` proxies the image the content object names: the object is the
  allowlist. Raster types only, no SVG, 10 MB, cached for seven days.
- Sessions come from the signed cookie cache; when it has lapsed, tela-api's get-session is asked
  and its fresh cookie passed on.
- `/discover`, `/s/:id` and `/@handle` are rendered here (`src/ssr.tsx`) with the SPA's own views,
  from tela-api's public JSON, into the built `index.html`, cached per colo, locale and deploy for
  five minutes, with the data handed to the SPA in `#tela-data`.
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
- `store/objects.ts` serves bodies and translations from memory, then IndexedDB, then `/o/*`. It
  prefetches unread bodies while idle and evicts read ones after seven days or 50 MB.
- `store/selectors.ts` answers the reading view: unread, lists, counts, the title to show.
- The URL alone says which article is open (ADR 0017's rule, kept): a click, a filter change or
  Back is a render, not a request.
- `views/` are Discover, a blog's page and a profile as pure components the edge renders too.
- Highlights: `lib/anchor.ts` finds a highlight again by leaf, quote and context;
  `lib/use-highlights.ts` paints them over the rendered text with the CSS Custom Highlight API and
  writes back an anchor the post moved. Typography and theme are synced prefs
  (`lib/typography.ts`); which panes show is this device's, in localStorage (`lib/layout.ts`,
  ADR 0029). `j`/`k`/`Esc`/`h`/`[`/`f`/`?` work on `/reading`.
- `public/sw.js` caches the app shell only, and swaps to a new shell only once every file it
  loads is cached; `shell/kill-sw.js` replaces it in an emergency.

| Route | Purpose |
|---|---|
| `/` | Landing for visitors; members go to `/reading` |
| `/login` | Email code, and the mail's link that submits the same code |
| `/reading?filter=&feed=&article=&mode=` | Sidebar, list and the open article |
| `/discover?topic=&lang=`, `/s/:id`, `/@handle?tab=` | Public pages, rendered at the edge too; a profile's tabs are cached apart |
| `/following?tab=` | What the people a member follows did, by RPC; whom they follow, from the device (ADR 0031) |
| `/search?q=` | The device first, then blogs and older posts from the server |
| `/add`, `/claim`, `/sites/:id/claim` | Add feeds and OPML; claim a blog |
| `/settings/:section?` | Profile, Reading, Translation, Subscriptions (with OPML in and out), Privacy (with "Your data") |
| `/dashboard` | The author's view |

## Sync (`packages/sync`, `packages/data/src/queries/sync.ts`, `apps/api/src/sync`, ADR 0025)

- One `seq` counter: every batch that writes a synced row bumps it and stamps its rows, so a
  device's cursor is simply the last seq it saw, and the server keeps nothing per device.
- The pull reads a member's own rows and the shared rows of the feeds they follow, plus the
  articles they keep (liked, recommended, highlighted), in one batch. The members they follow
  come as their own rows, re-sent when a followee's profile changes; what those members do does
  not sync at all, and arrives by RPC (ADR 0031).
- The push is guarded per mutation by `applied_mutations` and resolves conflicts by the later
  `at`, clamped to the server's clock.
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
- **Knowing it runs:** the dead-man's switch, the Monday digest, a verified nightly export, and
  D1's Time Travel (`docs/OPERATIONS.md`).

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
