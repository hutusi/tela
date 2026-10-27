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

Apps ──▶ tela-gateway (edge, unpinned, api.telaread.com): bearer only; /o/*, /img/*, /v1/bodies from R2
           │ service binding: /v1/*, /meta, /oauth/*, OAuth metadata, as /gateway/*; anything else 404
           ▼
         tela-api

tela.ainaive.com, www.telaread.com ──▶ tela-redirect: 301 to the same path on telaread.com; /sw.js the kill switch
```

The reader never waits on that picture: every screen renders from the rows the device holds,
and a sync keeps them current behind it (ADR 0025). Approved apps work the same way through their
own API at `api.telaread.com` (ADRs 0064, 0065): `telaread.com` is the origin for people, and
`api.telaread.com` the origin for apps.

## Monorepo

```
apps/reader       tela-web: the Vite + React SPA (src/) and the edge Worker (worker/);
                  tela-redirect, the old address's Worker (redirect/)
apps/api          tela-api: Hono, better-auth, sync, every reader RPC; the shared rules (src/core/),
                  the OAuth server and the API for apps (src/gateway/)
apps/gateway      tela-gateway: api.telaread.com, the API's bearer-only edge
apps/jobs         tela-jobs: the sweeps, queue consumers, the Ingest RPC, upkeep, backups, digest
apps/relay        the China fetch relay, the one Node process (ADR 0008)
packages/platform the seams: Db, Blobs, Jobs, Clock, Mail; ./cloudflare and ./portable adapters
packages/data     the SQLite schema, migrations, leases, the sync sequence, queries, backups
packages/sync     the sync protocol: row types, pull response, mutation schemas, the reducer
packages/ext      the API for apps, v1: each route's format (zod), the mappers, the opaque cursor
packages/edge     what both edges serve: content objects, bundles, the image proxy, behind authorize
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
| `profiles` | One per member: `handle`, `display_name`, `bio`, `ui_locale` and `reading_lang` (null follows the interface, ADR 0040), each with the `at` of the change that set it (`ui_locale_at`, `reading_lang_at`), whether the member shows their subscriptions and likes (`public_subscriptions`, `public_likes`, both off by default, each with the `at` of the change that set it and a version that every change counts up, which a show must name, issue #16), their picture (ADR 0032, 0033): the R2 key of one they uploaded (`avatar_key`), whether they show their Gravatar (`gravatar`, with its `gravatar_at`; never set counts as on), whether Gravatar has one for them (`gravatar_found`, asked at `gravatar_checked_at`), and `avatar_version`, the picture's version, which every change of picture counts up, and `is_admin`, who may open the admin console (granted only by the operator's token, ADR 0039). A member's standing: `suspended_at` (an operator's suspension, ADR 0059) and `deleted_at` (the account closed: the row stays for good as an empty shell holding the handle, ADR 0058), with `erased_at` once `member.erase` is done; `standingOk` is the one predicate every public query and guard uses |
| `user_prefs` | Synced preferences, one row per key: reading mode, text size, measure, theme (`lib/typography.ts`), the Reading and Translation settings `reader.mark_on_open`, `translate.auto`, `translate.never`, and the reading list's Unread / All switch, `reader.hide_read` (on unless set; `lib/prefs.ts`) |
| `sites` | A blog: normalized `home_url`, `listing` (private/listed/featured/rejected), `claimed_by`, `reader_count`, `translation_opt_out`, and `feed_only` (its writer's "Only use what my feed provides": no page of the blog is fetched, ADR 0061), an operator's review for Discover (ADR 0041, neither synced): what it decided (`review`, listed or dismissed; null keeps a blog a member added in the review queue, and `listed` keeps a blog in Discover through an Unfeature or a removed claim) and when the last decision was made (`reviewed_at`) |
| `site_topics`, `site_claims` | A blog's topics; claim attempts and how each was proved (`method`: a meta tag, a `rel="me"` link, a link on every page, or GitHub both ways, ADR 0045; a check that found no proof stores its reason as JSON in `error`), with the operator who vouched for one (`vouched_by`, so its check skips only the proof), when an operator last decided on it (`reviewed_at`, ADR 0039), and when one last rejected or removed it (`overruled_at`: from then on only the tag or `rel="me"` proves it) |
| `feeds` | The fetch unit: validators, schedule (`next_fetch_at`, `fetch_interval_sec`), `fetch_region`, `timeout_streak`, `status`, `content_mode`, `hub_url`, `merged_into` (another address for the blog's canonical feed, ADR 0028), `last_item_at` (the newest item it listed when last fetched, which the pull sends with the feed so Settings can say when a blog last posted, ADR 0049) |
| `articles` | `dedup_key` unique per feed, `sort_at`, `source_lang`, `current_version`, `content_key`, `extract_state` (with `extract_refused`, a failed one robots.txt refused, ADR 0061), counts. `AUTOINCREMENT` ids, so the unread watermark never meets a reused id. Ordered two ways: within a feed by `(feed_id, sort_at, id)` (`articles_feed_sort_idx`), and across every feed by `(sort_at, id)` (`articles_sort_idx`, Discover's Articles) |
| `article_versions` | Every body an article has had: provenance (feed or readability), `content_key`, `raw_key` (ADR 0022), and the `pipeline_version` it was made under (ADR 0055) |
| `article_titles` | Eager title and excerpt per launch language: `done`, `echo` or `failed` against the title hash |
| `block_translations` | The content-addressed block cache: source hash × target language × `NORM_VERSION` |
| `body_translations` | A body per content version and language: state, reservation (`reserved_spend` once it reckons the whole spend), streamed `chunk_keys`, the finished object (ADR 0023), and `due_at` for a request that waits for its day (ADR 0057) |
| `subscriptions` | `(user_id, feed_id)` with `watermark_id`: everything at or below it is read (ADR 0009) |
| `folders`, `feed_folders` | The member's private folders (ADR 0048): a folder by client-minted `id` with its `name`, soft-deleted; and which folder each blog is in, `(user_id, feed_id)` with `folder_id` (null is none) and the move's `updated_at`. A table apart from `subscriptions`, so a move never re-sends a feed's horizon; a filing outlives an unsubscribe |
| `blogrolls`, `blogroll_blogs` | The member's blogrolls (ADR 0050), synced to their member only; others read a public one through tela-api. A blogroll by a client-minted 12-character `id`, which is its address (`/l/<id>`), with its `name` and `description` (their clock is `updated_at`), `is_public` with a version of its own that a show must name (`public_version`, as the profile's switches, issue #16), `public_since` (when it first went public, never cleared: Discover's order) and the operator's Hide from Discover (`hidden_at`, never synced and never moving `seq`), soft-deleted. The blogs in each, `(blogroll_id, feed_id)` with `user_id`: the `note` on a clock of its own (`note_at`), so it outlives a removal, `added_at` (the order), and putting in and taking out on `updated_at` and `removed_at`. Unsubscribing touches neither |
| `user_article_states`, `recommendations`, `highlights` | The member's read and like state (a row with `read_updated_at` and no `read_at` is marked unread, which beats the watermark and the horizon until a later read; compaction keeps every row with that clock, ADR 0009), public recommendations with notes (indexed by `created_at` for the week Discover counts, `recommendations_created_idx`), private highlights with notes (ADR 0026) |
| `follows` | `(follower_id, followee_id)`: one member following another, one-way and public, soft-deleted, synced to the follower (ADR 0031) |
| `websub_subscriptions` | One per feed with a hub: topic, secret, status, lease |
| `leases`, `lease_fence` | Who holds which piece of background work, and the fence that aborts a stale holder's batch |
| `dead_letters`, `ops_heartbeats` | Work that gave up, until an operator retries or dismisses it (`resolved_at`, `resolution`, `resolved_by`); the last `tick`, `health`, `daily` and `digest` runs, the tick's with the switches tela-jobs runs with (ADR 0039) |
| `llm_calls`, `usage_daily` | Every model call, with the feed it was for (`feed_id`); reserved and used tokens per member and day (`'*'` is background, `'~closed'` the erased accounts' days folded together, ADR 0058), and `requests`, the body translations a member's day was charged (ADR 0057); the day's site total is the sum over every subject |
| `settings` | Runtime settings (ADR 0056): one row per setting changed from its default in `@tela/shared`'s `SETTINGS`, as JSON. Not synced; read inline by the statement that enforces a limit (`settingSql`) |
| `pending_feeds` | An import's feeds new to Tela beyond the member's day, which `member.pendingFeeds` adds on the days after (ADR 0063) |
| `reports` | Reports of public content (ADR 0059): who reported, what (`target_kind`, `target_key`), why, and where it stands. Not synced |
| `ops_alerts`, `robots_rules` | Operator mail already sent, one row per alert and day or hour (ADR 0063); a host's robots.txt as Tela last read it, the group that applies to Tela (ADR 0061). Neither is exported |
| `apps`, `app_grants`, `app_tokens`, `app_refresh_spent`, `app_codes` | Approved apps (ADR 0064, migration 0015), none synced. `apps`: the public `client_id` (`tela_app_…`), name, developer, the contact address the operator writes to, homepage and privacy URLs, `redirect_uris` and `grant_types` (JSON; only `code` is built, `device` is reserved), the ceilings `max_scope` and `allow_email`, which reach live tokens at once, `status` (`draft`, `approved`, `suspended`), `owner_user_id` (the one account a draft connects for) and its limits (`per_member_per_min`, `per_app_per_min`, `max_connections`: null is the default, 0 none). `app_grants`: a member's connection to an app, with the scope and email granted, `last_used_at` (stamped at most hourly) and `ended_at` with its `end_reason`; a partial unique index keeps one live connection per app and member. `app_tokens`: one row per device, its own scope and email, the SHA-256 of its current access and refresh tokens and their ends, `rotated_at`, and `pristine` (neither token used since made: only then is a lost answer swapped again); `kind` is `oauth` (`personal` reserved). `app_refresh_spent`: every refresh hash a device swapped away, so one coming back is reuse. `app_codes`: authorization codes by hash, two minutes, bound to their redirect and PKCE challenge, with the tokens they minted. Tokens, spent hashes and codes are not exported, so apps connect again after a restore |
| `post_opens` | Posts a member opened in full from blogs they do not subscribe to, one row per `(user_id, day, content_key)` (ADR 0066): what `member.unsubscribedPostsPerDay` counts. Swept after two days, not exported, deleted with the account |
| `action_limits`, `applied_mutations`, `tombstones`, `counters` | Reader action limits, and sign-in limits per email address; pushed mutation ids (replays change nothing); hard deletes for sync; the `seq` counter |

## Content pipeline

`packages/content`, pure TypeScript with no I/O (normative spec: `packages/content/README.md`):

1. Discovery (`findFeedLinks`, `findMetaRefresh`, `candidateFeedUrls`): `link[rel=alternate]`,
   feed-looking anchors; when the page declares none, those of one more page (where its meta
   refresh sends, else the blog's home); then well-known paths on the typed page's origin, and on
   the second page's when it answered from another. A WordPress comments feed is offered only when
   the blog has no other. An address that never answers (a timeout, a refused connection, a private
   address) ends discovery at once as `unreachable`, not as a blog without a feed.
2. Parsing (`parseFeedText`) with `feedsmith`: RSS, Atom, RDF, JSON Feed → `ParsedFeed` with
   `summaryHtml` and `contentHtml` per item.
3. Sanitize (`sanitizeArticleHtml`) with an allowlist; links and images absolutized; lazy-load
   attributes folded into `src`; tracking pixels dropped; a video, audio, player or link card
   replaced first by a link of its own to where it opens (ADR 0054).
4. Normalize + annotate (`annotateBlocks`): wrappers and table parts outside a table unwrapped
   (with a boundary where their words would run into their neighbours'), inline elements around
   blocks lifted, inline runs wrapped, `<p>`s split on `<br><br>` (ADR 0053), a highlighter's
   line-number table stored as its code, empty table cells kept, every
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
   shows as the post (`<template>` link previews, webmention and backlink containers), quiets
   layout utilities whose names hold Readability's negative words (`scroll-mt-*` cost a post all
   its headings), and puts each block of pictures in a `<figure>` (Readability deletes galleries
   otherwise). It refuses a result that is 70% link text or more (a site menu) or has under 100
   characters.

Fixtures: 21 captured real feeds in `packages/content/fixtures/`; snapshot tests pin block ids
and hashes as the `NORM_VERSION` contract (a leaf-shape fix may change them without a bump,
ADR 0053).

## Ingestion (`packages/ingest`, run by tela-jobs)

- `createHttpClient`: conditional headers, manual redirects with permanent-redirect detection,
  a 5 MB cap (10 MB for a feed, `FEED_MAX_BYTES`), charset-aware decoding, private-network refusal, and the relay hook for
  `fetch_region = 'cn'`. One abort signal per request, not per redirect hop. A 206 whose
  `Content-Range` covers the whole file is read as a 200 (Caddy answers so for a precompressed
  file, unasked). A body past the cap fails `too_large` carrying its status and first 16 KB, so
  discovery calls only a 200 that begins as a feed a feed too large to read.
- `ingestFeed` (`pipeline/feed.ts`) runs a whole fetch under the feed's lease: conditional GET,
  relay flip, alias detection, provenance and declared-home adoption, the 200-item cap,
  content-mode learning, scheduling. Everything commits in one fenced batch, so two fetches of one
  feed cannot interleave (the lease is the per-feed serialization). Each item's content object
  and raw HTML are written as it is processed, before that batch, and not held for the whole
  feed: held, they cost about 13 times the feed's size.
- One blog, one feed (`pipeline/merge.ts`, ADR 0028): before fetching, a feed whose blog has
  other active feeds checks whether it holds the same post URLs as one of them over the time
  both cover. If it does and the other is canonical (on the blog's own host, else older), it
  pauses itself with `merged_into`, moves its readers, their filings and its places in blogrolls
  (with their notes, unless the target is in that blogroll already: ADRs 0048, 0050), the posts
  only it had and their titles, translations and read states across, and stops. Adding,
  importing or subscribing to a merged feed lands on its target.
- Scheduling: interval = half the average gap between posts over 7 days, clamped to 30 min…24 h,
  ×1.5 when unchanged, raised to the publisher's `ttl`/`max-age`; ±10% jitter on the derived
  `next_fetch_at` only. Errors back off `interval × 2^n` up to 7 days; 429/503 honour
  `Retry-After`; 410 or 30 consecutive errors mark a feed dead, and the nightly upkeep revives it
  after a week.
- Versions: `chooseCurrent` decides which body readers see. A summary feed's current version is
  its latest Readability extraction, so a changed summary asks for a new extraction instead of
  replacing the full text.
- `reprocessArticleJob` (`pipeline/reprocess.ts`, kind `article.reprocess`, ADR 0055): an
  article whose current version was made under an older `PIPELINE_VERSION` is made again from
  the raw HTML it was stored with. A different content object becomes a new version of the same
  provenance, `extract_state` untouched; the same one is stamped current. No fetch and no host, so
  its pace is the tick's limit, newest first.
- `extractArticleJob`, `siteAssetsJob` (raster favicons to `tela-assets`), `verifyClaimJob`
  (`pipeline/proofs.ts` reads the home page: a meta tag, a `rel="me"` link to the profile, or a
  link without one that the blog's 404 page shows too, to the profile or to a GitHub whose
  website is the blog, asked of `api.github.com` by the member's GitHub id; then provenance; ADR
  0045), `websubSubscribeJob`, and `gravatarCheckJob`
  (`pipeline/gravatar.ts`: whether Gravatar has a picture for a member, recorded and never copied,
  ADR 0033).
- `createIngest` (`pipeline/rpc.ts`) is what tela-api reaches over the `Ingest` RPC: discovery,
  adding a feed, starting a claim, reading OPML (its feed URLs, and by name the folders it lists
  them in, an optional field so a tela-api reads an older tela-jobs' answer). The parsers never
  enter tela-api's bundle.
- `relay.ts` is the relay client (HMAC-SHA256 over a timestamp and the body); `region-policy.ts`
  flips a feed to the relay on its third consecutive timeout while the control URL answers.

## Background work (`apps/jobs`)

- `src/kinds.ts` is the one table of background work: for each kind, the due query over a domain
  row, the lease length, backoff, queue, handler, what exhaustion writes, and whether it is enabled.
- `tick` (every minute) claims each kind's due work under a lease and sends it to its queue (a kind
  that fails is recorded in its heartbeat and passed, and the health check reports it);
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
  ended sessions, better-auth's counters after a day, spent sign-in codes and OAuth states, and
  the day before yesterday's `post_opens` (ADR 0066).
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
- Every fifth minute, beside the health check, `checkAlerts` mails the operator when the day's
  translation budget reaches a share, sign-ups pass `alerts.signupsPerDay`, or new reports wait:
  an `ops_alerts` row inserted first, so each is mailed once (ADR 0063).
- `member.pendingFeeds` adds an import's waiting feeds as a member's day and cap have room (ADR
  0063); `member.erase` removes what a closed account's own devices held, 10 minutes after it
  closed, in fenced chunks that recount likes, recommendations and readers first (ADR 0058).
- `src/portable.ts` runs the same tick and jobs on a timer with an in-process queue: the exit path,
  and what the test-mode `cycle()` uses.

## Translation (`packages/llm`, `apps/jobs/src/translation`)

- `packages/llm` is the adapter: a `Translator` interface over Bailian (GLM), Anthropic and a
  deterministic mock. `translateBlocks` sends each block with its whitespace collapsed, validates
  every block (placeholder multiset, length ratio, non-identity) and retries failures once in
  strict mode.
- **Titles, eager** (`translate.title`, keyed by feed): the sweep finds feeds with articles whose
  current title hash has no row in some reading language (`READING_LANGUAGES`: `zh-Hans`, `zh-Hant`, `en`, `fr`); a job translates up to 20 titles and
  excerpts of one feed per call per language, and commits each (language, source) group in its
  own fenced batch as it lands, newest posts first. The background budget (`usage_daily` subject
  `'*'`, `translation.backgroundDailyTokens`) and the site's day (`translation.siteDailyTokens`)
  stop the sweep for the day once spent (ADR 0057).
- **Bodies, lazy and streamed** (`translate.body`, ADR 0023): opening a foreign post is admitted
  by count (`usage_daily.requests` against `member.translationsPerDay`) and by the site's day,
  reserves against the day it is charged to, and claims the work at once. Past either, the row
  waits until the next UTC midnight (`due_at`), one day deep, and a member with room today who
  opens it takes it over (ADR 0057). Groups follow top-level block boundaries,
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
| `GET /api/v1/sync?cursor=&titles=` | The pull: a horizon snapshot at cursor 0, deltas by seq in pages ending on a seq boundary; titles only in the language `titles` names, said back as `titlesLang`, else in every language (ADR 0052) |
| `POST /api/v1/sync/titles` | Titles of named posts in one language (ADR 0052), for a device whose reading language changed: `{lang, ids}`, up to 1,000 ids, answers `{rows}` in the pull's title shape, only of feeds the member follows or posts they keep. One statement (`readTitles`): the ids one JSON parameter through `json_each`, six bound parameters, one three-term union. 400 `invalid_titles` or `invalid_ids` |
| `POST /api/v1/mutations` | The push: up to 50 idempotent, last-writer-wins mutations in one batch |
| `/api/v1/translations` | Request a body translation; poll its streamed state |
| `/api/v1/feeds` | Discover feeds at a URL, add one, import and export OPML. When nothing is found but a feed was too large to read, discovery and adding answer `feed_too_large` (422), not that there is no feed. An import's folders become the member's (ADR 0048): a feed is in the nearest outline around it that is not a feed, one level only; a name the member has a live folder for, case aside, files into it, and another makes a folder while they have fewer than 100. Only a blog in no live folder is filed, so an import never moves one the member filed; no folder is made that would hold nothing. An export is one outline per live folder, by name, holding its blogs by title, then the blogs in none |
| `/api/v1/claims` | Start a claim, see its proofs (and whether the member has a GitHub to claim by), ask for the check; a failed check comes back as a `reason` the page words, or as text |
| `/api/v1/profile`, `/api/v1/sites/:id/*`, `/api/v1/dashboard`, `/api/v1/search` | Handle and profile, owner-only topics and opt-out, the author dashboard (per blog its language, topics, readers and those new in 30 days, and its live totals of posts, likes, recommendations and notes; per post, the newest twenty, likes, recommendations and notes; readers' notes with their avatars), search past the device's horizon |
| `GET /api/v1/following`, `GET /api/v1/sites/:id/followed-readers` | What the people a member follows recommended, liked and subscribed to, thirty entries a page behind a (time, offset, key) cursor, a day's likes grouped and placed at the newest; which of them read a blog. Only as far as each shows it (ADR 0031). Readers to follow come from Discover's pool, matched on the device (ADR 0044): `suggested` is always empty, kept for shells cached before that, which read it |
| `GET /api/v1/export` | "Your data": the member's own rows as one JSON file, their live blogrolls included, private ones too, with their blogs and notes; their claims, invite codes and who joined by them, the invitation they joined by, read states, and their picture's address (ADR 0058) |
| `POST /api/v1/account/delete/code`, `POST /api/v1/account/delete` | Closing one's own account (ADR 0058): a code mailed from Tela's own `verification` row (`otpSend`), then the code (`otpVerify`, three tries); refused for an admin. `closeAccount` empties the account in one batch, `closures/<id>` is written to R2 first, and the answer clears the browser's cookies |
| `GET /api/v1/account/usage` | A member's limits, live (ADR 0063): today's translations against `member.translationsPerDay` and how many wait, today's new feeds and how many wait in `pending_feeds`, subscriptions against the cap, and today's posts opened from blogs they do not follow against `member.unsubscribedPostsPerDay` (ADR 0066); null for an exempt admin. `readUsage` in `src/core/usage.ts`, which the API's `/v1/usage` words its own way |
| `GET /api/v1/articles/:id` | A post by id, as the device holds a synced one (ADR 0066): `{article, feed, site}` in the sync's row shapes, content key included. What a member opens from a public page, whose answers carry no key; the day's limit counts when the body is fetched, not here, since anyone holding a key could skip this route. Reads the member's standing from D1, as a write does |
| `GET /api/v1/connect/request`, `POST /api/v1/connect/decide` | The consent page's two questions (ADR 0064, `routes/connect.ts`), behind the web's origin, member and client checks, so an app's token never reaches them. The authorization request is checked in an order the page can trust (the client, then the redirect, then the rest: a loopback redirect matches on any port, a registered scheme exactly, `localhost` never) and answered as the page shows it (`ConnectRequest`) or as `{error}`, which the page shows and never redirects on. A draft is offered only to its owner, a suspended app to no one, a full app to no new member. The decision checks it all again and answers `{redirect}`: a new code on approval (single-use, two minutes, bound to the PKCE challenge and the redirect), even for an app already connected (RFC 8252 §8.6); `access_denied` on decline; `iss` either way (RFC 9207). 30 answers an hour per member (`appConnect`) |
| `GET /api/v1/connections`, `DELETE /api/v1/connections/:id` | Settings → Connected apps, live: each live connection with what it may do now (lowered by the app's ceiling), when it was connected and last used, and how many devices hold tokens; disconnecting ends it and every device's tokens under it in one batch |
| `POST /api/edge/opens` | tela-web's edge asking whether the session's member may have these posts (ADR 0066, `routes/edge.ts`): `{keys}`, at most 25 content keys, answers `admitOpens`'s `{allowed, refused}`. Outside the `/api/v1/*` member checks, since the edge forwards the member's cookie and nothing else; standing and `is_admin` in one read (a closed or suspended account is a 401; an admin is exempt, on the web only). tela-web answers `/api/edge/*` 404 to browsers, so only the edge reaches it |
| `/gateway/*` | The API for apps (ADRs 0064, 0065; *The API for apps*, below): the OAuth endpoints and `/v1/*`, bearer tokens only, reached only through tela-gateway |
| `POST /api/v1/claims/:siteId/release` | The claimant lets a blog go (ADR 0058, `releaseClaim`); its switches stay as they set them |
| `PUT /api/v1/sites/:id/feed-only` | The claimant's "Only use what my feed provides" (ADR 0061); due extractions of the blog go back to `none` |
| `POST /api/v1/reports` | A member reports a profile, blogroll, blog or note shown now (ADR 0059); one open report per reporter per target, `report` 20 a day |
| `GET /api/v1/public/sitemap`, `/sitemap/<kind>?page=` | What tela-web's sitemaps list (ADR 0060): the indexable blogs, blogrolls and profiles, with `lastmod`, by the same predicates (`SITE_INDEXABLE`, `BLOGROLL_INDEXABLE`, `profileIndexable`) that give site, blogroll and profile answers their `indexable` |
| `GET /api/v1/public/feeds/blogrolls/:id`, `/feeds/discover?topic=` | What tela-web's RSS and OPML are made of (ADR 0062): listed blogs only, every language's current titles at once, none for a blog that opted out of translation |
| `GET`, `POST /api/admin/settings`, `POST /api/admin/closures` | Bearer `ADMIN_TOKEN`: the runtime settings, read and set as the console's `setting.set` does (ADR 0056); close again the accounts whose closures R2 holds, after a restore (ADR 0058) |
| `GET /api/v1/public/auth` | Which providers the sign-in sheet may offer, `{google, github}`, each once its app is configured (ADR 0036), and `signup` (`open` or `invite`) and `paused` (the day's new accounts reached `signup.maxPerDay`, ADR 0056); cached 60 s |
| `/api/v1/public/*` | Discover's Blogs at `/discover`, which the page `/discover/blogs` reads (60 blogs a page, `?page=`, with the `total` its filters match), a blog's page (with its claimant and readers' notes), a profile (with follow counts, its public blogrolls newest first, each with its first three blogs and its count, hidden from Discover or not, and liked posts only if shown): listed and featured blogs only; a page tela-web renders from them keeps its copy per colo for their `s-maxage`. No public answer, nor the Following feed (other members' posts), carries a content key (`PUBLIC_ARTICLE_COLUMNS`, ADR 0066), for visitors and members alike, so the colo's copy stays one; a member opens such a post through `GET /api/v1/articles/:id`. Search keeps the key: it finds only posts of the member's own feeds A blog's reader count is given from three readers and is null below, in Discover's order as well as its value (`publicReaderCount`, ADR 0041); member search gives it the same way |
| `GET /api/v1/public/avatars/:userId?v=` | A member's picture, only at the version it is at (ADR 0032, 0033): the one they uploaded, from R2, else their Gravatar while they show it and the check found one, fetched here by the hash of their email, which never leaves tela-api; raster types only, 512 KB, immutable for 30 days; none is a 404 the letter stands in for |
| `GET /api/v1/public/front` | The front page's edition (ADR 0035): each public blog's newest post, newest first, from the last seven days, or the latest ones when nobody wrote that week, eleven at most, with its titles and translated excerpts, its blog and its claimant; and the counts the copy states, public blogs and the week's distinct blogs, languages and posts. Each blog's newest post is one seek per live feed down `articles_feed_sort_idx`; future-dated posts wait. Cached as a profile is |
| `GET /api/v1/public/discover/week`, `/articles`, `/readers` | Discover's other tabs (ADR 0044), in `apps/api/src/routes/discover.ts`: one answer for everyone, which the device personalizes from its own rows, so nothing about the viewer is asked. This week: the rolling seven days' recommended posts, the most recommended first, then the newest; the front page's edition beside them (`editionStatement`, shared with `/front`), for the device to fall back on; twelve blogs new in the directory, every listed blog alike, by when it arrived or was claimed and never by an operator's review; and readers to suggest. Articles (`?topic&lang&cursor`): every public post newest first, thirty a page behind a `sortAt:id` cursor cut by key down `articles_sort_idx`, never by offset; the week's recommended, whole, on the first page only; the languages of the last 90 days within the topic. Readers: `readersPool`, the people who recommend or show what they read, in two round trips, each with their newest recommendations as `[articleId, siteId]`, the public blogs they show (null unless they do), their earliest find (by recommendation id, never the device's `at`, from two others after) and their newest note, of posts whose date has come. A post carries its week's recommendations, up to twenty recommender ids and its newest note. Listed and featured blogs, live feeds and posts whose date has come only; no answer says how a blog was listed. Cached as a profile is |
| `GET /api/v1/public/blogrolls/:id` | A public blogroll's page (ADR 0050, `routes/blogrolls.ts`): its name, description and `updatedAt` (the latest of its own clock and what its blog rows show others: blogs put in or taken out, notes on blogs still in, none of the operator's rejected blogs), its owner, and its blogs in the order added. Each blog has its name (`BLOG_NAME`: the blog's title, or its feed's while the blogroll holds another live feed of the same blog), home, favicon, language, description (300 characters at most), whether it is listed (the page links a listed one to `/s/:id`, any other to the blog), its reader count from three, whether its feed is dead, and the owner's note. Blogs the operator rejected are left out. A malformed id, or a blogroll unknown, deleted or private, is a 404. Cached as a profile is |
| `GET /api/v1/public/discover/blogrolls?cursor=` | Discover's Blogrolls tab (ADR 0050), in `apps/api/src/routes/discover.ts`: public, live blogrolls the operator has not hidden, with three or more blogs others see (`inDiscover`), newest public first by `(public_since, id)`, thirty a page behind a `<publicSince>:<id>` cursor cut by key, never by offset; each with its first five blogs and how many others see. Cached as a profile is |
| `GET /api/v1/public/handles/:handle` | Whether a handle is free, for For writers' card as it is typed: `invalid`, `reserved`, `taken` or `available` (by `@tela/shared`'s rules, read lowercase), and the first free one among it, it plus a digit and it plus `_writes`. `no-store`; a valid shape is counted per IP (`handleCheck`, 300 an hour) |
| `PUT`, `DELETE /api/v1/avatar` | A member's own picture (ADR 0033): its bytes say what it is (PNG, JPEG or WebP, square, 64–1024 px, 512 KB), kept in R2 `tela-content` under `avatars/<userId>/<random id>.<ext>`, a key never used twice, so a deletion can only take the object its own change replaced; the body is read no further than 512 KB, and twenty an hour are counted before any is read; each change moves the version and deletes the object it replaces |
| `POST /api/admin/admins` | Bearer `ADMIN_TOKEN`: open or close the admin console to a member (`profiles.is_admin`, ADR 0039); only the token grants it |
| `/api/v1/admin/*` | The admin console (ADR 0039), for a member with `is_admin`, read from D1 on every call past the signed session copy: `counts` and `overview`; `claims`, `sites`, `feeds`, `discover`, `people`, `invites`, `apps` (ADR 0064), `translation` and `system` as filtered, searched lists (500 rows at most; People and Invitations take a search as a POST body, since it is often an email address and a URL reaches the Workers' logs) and their records; `translation/report` and `system/report`; `POST act` (an action on up to 50 targets, each its own audited batch) and `POST undo` (a group restored only while every target still holds what the action wrote). Discover's `blogrolls` filter and `blogrolls/:id` list public, live blogrolls only, never a private one, with the owner's handle and their visible and total counts; `blogroll.hide` and `blogroll.restore` write `hidden_at` with no `seq` and no `updated_at`, so nothing syncs and the owner is not told (ADR 0050). Under `/api/v1`, never `/api/admin`, so its writes are held to the same origin |
| `/api/websub/:feedId` | The hub callback: intent checks, and signed pings that make the feed due |
| `POST /api/client-errors` | What breaks in a reader's browser (`routes/client-errors.ts`): a render an error boundary caught, an error or rejection left unhandled, a failed boot, a CSP violation, and why a device started over from a snapshot (`restart`, logged apart as `client restart`). No session, so a visitor's page reports too; 8 KB, counted per IP (`clientError`, 30 an hour, and CSP violations apart as `clientCsp`, named in the `x-tela-report` header) before it is read; one log line each (kind, message, stack cut to 4 KB, path, build), with every query string cut first, and nothing stored |
| `/api/health` | Liveness and D1 latency |

Every `/api/v1/*` route but the public ones and `/api/v1/join` needs a session, read from the
signed five-minute cookie cache; `/api/v1/account/*` reads it from D1 again, so a session ended
elsewhere changes nothing there. A closed or suspended account (ADRs 0058, 0059) is refused a
session (`session.create.before`), and `guarded` reads its standing from D1 on `/me`, the sync,
the export and every call that writes, answering 401 within the signed copy's five minutes. Reader actions are rate-limited per member (`action_limits`).

**Shared rules** (`src/core/`, ADR 0065). Every rule the web and the API for apps both apply is
one function that takes an actor (`{userId, exempt}`, `Actor` in `@tela/data`) and returns a plain
result, never a Response, and never reads a request, a header or `is_admin`: asking for a body
translation and its status (`requestBodyTranslation`, `translationStatus`), discovering, adding
and importing feeds (`discoverFeeds`, `addFeedFor`, `importFeeds`), usage (`readUsage`), and the
public side's reads (`core/public.ts`: `readDiscover`, `readSitePage`, `readProfile`,
`readBlogroll`, `search`, `readArticle`), which decide inside what may be shown (listing,
standing, privacy switches, reader counts from three, no translated title of a blog that opted
out). The pull and the push (`answerPull`, `applyPush`), the limits in `@tela/data`
(`feedRoom`, `subscriptionRoom`, the translation ask) and `admitOpens` take `exempt` the same
way. The web's routes pass `exempt` from `is_admin`, read beside the standing the member check
already reads for every write (`memberStanding`); the API always passes `false`. Each surface
words the result its own way, so the web's routes stay free to change.

No request body is read past 64 KB, a push past 1 MB (`bodyCap` in `src/app.ts`), a 413
`too_large` before any route sees it; the picture, an OPML file (1 MB) and a hub's notification
(5 MB) read their own no further than their own caps. A route nobody serves is a JSON 404, and a
failure a JSON 500 `internal`, logged with its path, `cf-ray` and member.

## The edge (`apps/reader/worker`, tela-web)

The only public Worker, unpinned, with no D1.

- Public pages (the landing, Discover, blogs, blogrolls, profiles, the info pages and For
  writers) are rendered here in the visitor's language: `?hl=` first, then the `tela_locale`
  cookie, then Accept-Language; a member always gets their own (ADR 0060). Each page's `<head>`
  (`src/lib/head.ts`) carries its canonical, hreflang alternates for the four languages and
  x-default, Open Graph with a share card per language, and JSON-LD; a page nobody has vouched
  for (a new profile, an unreviewed blog) says `noindex`, mirrored as `X-Robots-Tag`.
- `/robots.txt`, `/sitemap.xml` with `/sitemap-{pages,sites,blogrolls,profiles}.xml`, and
  `/llms.txt` are generated here (`worker/robots.ts`, `sitemap.ts`, `llms.ts`, ADR 0060); while
  `TELA_NOINDEX` is set, robots.txt shuts everything and every answer says noindex.
- `/l/<id>.rss`, `/l/<id>.opml`, `/discover/articles.rss` and `/discover.opml` are Tela's own
  feeds (`worker/feeds.ts`, ADR 0062), rendered from tela-api's JSON through the colo copy, with
  an ETag; titles in the `?hl=` language where one exists, never full text.
- `/api/*` goes to tela-api; a write must carry this origin (hubs and the admin script exempt).
- The app's own GET of `/api/v1/public/*` goes to tela-api every time, as every `/api/*` does. The
  public pages rendered here read the same JSON through a copy per colo instead (`pageJson`), keyed
  by its path and query alone (the answers carry every language): a 200 or 404 is kept when it sets
  no cookie and says `s-maxage` with none of `no-store`, `private` or `no-cache`, for as long as
  `s-maxage` says, so a page's four languages cost one D1 read a colo, and a page is kept only for
  what its data's five minutes had left, so the two caches never add up to ten. The app does not
  read that copy: served from it, a member's own claim, hide or follow stayed out of the lists for
  up to five minutes, since nothing they did could tell every list it touched to ask again.
- `/o/c|t|tc/…` and `/o/bundle` serve immutable objects from R2 to members, cached per colo;
  raw HTML (`r/`) and backups are never served. `/img/<contentKey>/<i>` proxies the image the
  content object names: the object is the allowlist. Raster types only, no SVG, 10 MB, cached for
  seven days; a failure (the host's error or timeout, a private host, no such image) is cached ten
  minutes, at the colo and in the browser, so a broken image is not asked for on every view. Both
  are `@tela/edge`'s (`packages/edge`), the same handler tela-gateway serves.
- **Every object and image is decided before it is served** (ADR 0066). `authorize` is the session
  check, then `POST /api/edge/opens` over the binding with the member's cookie alone, for the
  content keys this colo has not already allowed the member today. A translation, a chunk or an
  image is decided by its post's content key, so it costs no place of its own. Each key allowed is
  kept in the colo until the UTC day ends, under the SHA-256 of the member's id and the day
  (`createMarks`, with the end checked on read as well as told to the cache), so a body's
  translations and images cost one cache read, not a round trip to Singapore, and no member id
  sits in a cache key. The decision runs before the colo's copy of the object is read, so a post
  refused today is never served from a copy another member put there. A refusal is never kept: a
  member who subscribes reads the post at once. A refused object or image is a 429 with
  `Retry-After` and `{error: 'post_limit', limit, resetsAt}`, kept by nobody; a bundle answers
  `{objects, refused}`, immutable only when it refused nothing. A decision tela-api cannot give is
  a 503 with `Retry-After`, never an allowance.
- `/avatar/<userId>?v=<n>` is a member's picture (ADR 0032), from tela-api's
  `/api/v1/public/avatars/:userId`, cached per colo for as long as tela-api says (30 days for a
  picture, since the version is in the address). Public, and it asks tela-api nothing for an
  address that names no member or version.
- Sessions come from the signed cookie cache; when it has lapsed, tela-api's get-session is asked
  and its fresh cookie passed on.
- Discover's five tabs (`/discover`, `/discover/articles`, `/discover/blogs`,
  `/discover/blogrolls`, `/discover/readers`; ADRs 0044, 0050), `/s/:id`, `/@handle` and a
  blogroll's `/l/:id` (ADR 0050) are rendered here (`src/ssr.tsx`) with the SPA's own views, from
  tela-api's public JSON, into the built `index.html`, cached per colo, locale and deploy for five
  minutes, with the data handed to the SPA in `#tela-data`. The page is the visitor's: a member's
  device hides their own blogs and adds whom they follow once the app boots. A 404 is cached the
  same way: a private, deleted or unknown blogroll is the Not found page, which boots the app with
  `createRoot`, so the owner's device renders their own blogroll over it from the local store. A
  blogroll made public just after someone opened its link is still that Not found page at the
  colo for up to five minutes, which the app replaces once its own request finds the blogroll.
  `/discover/blogrolls` always exists, so an
  answer missing from tela-api is the plain shell, not a 404. `/discover` with the Blogs page's
  old filters (`topic`, `lang`, `page`) is answered 301 to `/discover/blogs` with its whole query,
  asking tela-api nothing.
- `/` is the front page (ADR 0035), rendered the same way for visitors from
  `/api/v1/public/front`, one page for each title mode (`?titles=translated`), and from its own
  key, never the address asked. A request whose cookie holds `tela.session_token` is a member's:
  the plain shell from the assets, before the cache lookup, with no call to tela-api, never
  cached. Any answer but a 200 from tela-api, a 404 included, is the plain shell, uncached, never
  a 404 page at `/`; so is a call that throws or takes more than three seconds, body included
  (`PAGE_DEADLINE_MS`), on every public page: a slow D1 never keeps a page blank. That fallback
  is a 503 with `Retry-After: 120` and `no-store` (ADR 0060): the shell's own head says
  `noindex`, which a crawler would read as the page's answer from a 200. Every browser response for `/` carries `Vary: cookie`; the colo's copy
  carries none (workerd ignores Vary), since only a visitor's copy is stored. A test
  (`apps/reader/test/routes.test.ts`) holds every public page to `run_worker_first`.
- `/about`, `/privacy` and `/terms` are rendered the same way from the bundle alone: their route
  has `api: null`, so the edge asks tela-api nothing and hands nothing over (ADR 0035).
- Every HTML answer carries the security headers (ADR 0051, `worker/security.ts`): the Worker
  sets them on what it builds, and `public/_headers` gives the same set to what the asset router
  serves. The CSP is report-only; HSTS, `nosniff`, Referrer-Policy, Permissions-Policy and
  `X-Frame-Options: DENY` are enforced. Hashed assets are kept a day in the browser.
- Everything else is the SPA's static assets, which answer without running the Worker. A path
  with no file is answered 200 with `index.html`, a missing `/assets/*` script included:
  `run_worker_first` is a list, and then the fallback applies to every request, not only
  navigations.

## The API for apps (`apps/gateway`, `apps/api/src/gateway`, `packages/ext`, ADRs 0064, 0065)

Apps the operator approves act for a member at `https://api.telaread.com`, never with a cookie and
never as an admin. What a developer reads is `docs/api/`.

- **tela-gateway** (`apps/gateway`) is a thin edge Worker on the custom domain, unpinned, with
  `tela-content` (read-only), the colo cache and the `API` binding to tela-api: no assets, no D1,
  no vars, no secrets. Every request loses its `Cookie`, and any `Authorization` that is not
  `Bearer tela_at_…` is refused here with a 401, except on the routes that take no token (`/meta`,
  `/robots.txt`, `/.well-known/oauth-authorization-server`, `/oauth/*`). Every answer carries
  `x-robots-tag: noindex`, HSTS and `tela-api-version`, and never a `Set-Cookie`; `/robots.txt`
  disallows everything. Paths are logged, query strings never.
  - `/o/*`, `/img/*` and `/v1/bodies?keys=` are served here by `@tela/edge`, as tela-web serves
    them. `authorize` is `POST /gateway/opens` with the app's token; tela-api's 401, 403, 429 and
    503 reach the app as they are. An allowed (token, key) is kept 60 s in the colo under the
    SHA-256 of the token, never the token itself, so an app cut off loses its images within a
    minute; a refusal is never kept.
  - The public side (`/v1/discover/*`, `/v1/sites/*`, `/v1/profiles/*`, `/v1/blogrolls/*`) is the
    same for every viewer, so tela-api's answer is kept five minutes per colo, keyed by path and
    sorted query and never by token, and served only to a token tela-api accepted in the last
    minute. Only answers that name `?lang=` are kept (without it, tela-api answers in the member's
    own reading language), and nothing tela-api marks `private`, `no-store` or `no-cache`.
  - `/meta` takes no token and says the same to everyone, so tela-api's answer
    (`public, max-age=300`) is kept five minutes per colo for every caller, and an app starting up
    reads no D1.
  - The rest of `/v1/*`, `/meta`, `/oauth/*` and `/.well-known/oauth-authorization-server` go
    to tela-api as `/gateway<path>`: outside `/api/`, so tela-web's forward never reaches it, and
    tela-api keeps no public route (ADR 0024). tela-api not answering is a 503 `unavailable` with
    `Retry-After`. Any other path is a 404 `not_found` here (`forwarded`): `/gateway/opens` is
    this edge's own question, which an app asking directly would spend its member's day with.
- **tela-api's mount** (`src/gateway/`, at `/gateway`): nothing under it reads a cookie or a
  session, and nothing under `/api/` reads its tokens. Every answer says `tela-api-version` and is
  `no-store` unless its route says otherwise.
- **The authorization server** (`gateway/oauth.ts`, `gateway/authorize.ts`, `queries/apps.ts`):
  OAuth 2.1 for public native clients (RFC 8252), the authorization code with S256 PKCE and
  nothing else; RFC 7009 revocation, RFC 8414 metadata, RFC 9207 `iss`. The issuer is `API_URL`;
  the authorization endpoint is the reader's `/connect` (`PUBLIC_URL`), whose questions are
  `routes/connect.ts`. Every write that decides is one conditional statement or one batch read back
  through `RETURNING`:
  - the code exchange spends the code only if it is unspent, unexpired and bound to its client,
    redirect and verifier, with the app usable, the member in good standing and the connection
    live, and inserts the device's tokens only if it was spent. A code that comes back with its
    verifier ends the tokens it made;
  - a refresh is one conditional swap of both hashes. The hash it replaces goes to
    `app_refresh_spent`; a spent hash coming back ends the device, except the one swapped away at
    the device's last rotation, within two minutes, while its replacement is `pristine` (a lost
    answer);
  - revocation ends the device whose access or refresh token it is, for that client, and answers
    200 whatever it found;
  - the token endpoint counts 30 requests a minute per app and IP (`appToken`), only for a
    `client_id` that exists, and answers 503 `apps_paused` while `apps.enabled` is off.
- **The bearer** (`gateway/auth.ts`, `resolveToken`): one batch reads token, connection, app and
  profile together (the app approved, or a draft of this member's; `apps.enabled` on;
  `standingOk`), counts the app's requests for this member and in all (`appMember`, `appTotal`, a
  minute each: the app's own limits, else 120 and 6,000; 0 is none), clears `pristine` and stamps
  last use at most hourly. Only a token the read accepts counts or stamps anything. The principal
  (`AppPrincipal`) is the member, the app, the device and a scope, the lower of the token's and
  the app's `max_scope`, so lowering an app reaches live tokens; email needs both the token's and
  the app's permission. It holds no admin flag, and every shared rule is called with `exempt:
  false`. `requireScope('write')` answers 403 `insufficient_scope` with `WWW-Authenticate`.
- **Formats** (`packages/ext`): each v1 route's request and answer as a zod schema (`./schema`,
  the source of the OpenAPI document), and the parts an edge may import without zod (`./transform`:
  the error codes, the row types, the opaque cursor). Conventions are the internal API's (camelCase,
  epoch milliseconds, integer server ids, string ids a client mints); every enum says whether it
  is open. The cursor is base64url JSON of the seq, the one reading language and the row types it
  holds whole; another language, a type it does not cover, or a cursor Tela did not make starts a
  snapshot. v1's sync sends titles and translation rows in the asked language only, and none of a
  blog that opted out of translation, so the web's per-language storage (ADR 0052) never reaches
  apps. Each route's answer is a mapper from a shared function's result, and golden fixtures
  (`docs/api/`'s examples, checked `.strict()`) pin every route: a change to a shared function
  that moves v1 fails the suite, and the fix goes in the mapper.
- **Connections end** wherever Tela ends a member's other sessions, in the same batch
  (`endConnections`): `endOtherSessions` in `auth.ts` (a password set or changed, a provider
  linked, sign out everywhere), `onPasswordReset` (better-auth deletes those sessions itself), the
  console's sign-out and suspension (held to the suspension's own condition with `onlyIf`), and
  `closeAccount`, so `reapplyClosures` too. A member disconnecting in Settings and the console's
  *End all connections* (`endAppConnections`, reason `appEnded`) end them too. Cutting an app off
  ends nothing: its status refuses every token on the next call, and a restore brings it back for
  those who connected it. A token is read from D1 on every call, so an app stops at once, where a
  browser's signed session copy lasts five more minutes.
- **The console's Apps area** (`routes/admin/members/apps.ts`, ADR 0039's framework): `app.create`
  (a draft, its `tela_app_` client id), `app.edit`, `app.approve`, `app.suspend` (*Cut off*),
  `app.restore`, each audited with an undo, and `app.endConnections`, one-shot and confirmed. Its
  settings are checked by `parseAppSettings` (`@tela/shared/admin`), the rule the console's form
  runs too. An audit row never holds the contact address, and the record counts who connected an
  app without naming them.

## The reader (`apps/reader/src`, ADRs 0025, 0026)

A Vite + React SPA that renders from the device.

- Nothing leaves the page blank (`main.tsx`, `components/error-boundary.tsx`). A device store
  that opens and then fails is replaced by one in memory. A page that throws as it renders shows
  "Something went wrong" with Try again below a header that still works (its boundary clears when
  the address changes, query included, without remounting the page), and an article that throws
  fails in the reader's pane alone, beside a list that still works; the root boundary, outside every provider, words the app's own failure from the
  catalogues, as a boot that fails does on an empty shell (an edge-rendered page stays as it is).
  `lib/report.ts` sends what broke to `/api/client-errors`: what a boundary caught, an unhandled
  error or rejection whose stack runs through Tela's own scripts, a failed boot, each CSP
  violation not set off by an extension, and why the device started over from a snapshot
  (`LocalStore.onRestart`, with the build that last wrote `kept`), each once, five errors and three
  violations a page load at most, never a query string (`withoutQueries`, in `@tela/shared` for
  both ends).
- `store/local.ts` holds confirmed rows and pending mutations, written through to IndexedDB, one
  record per pending mutation so that tabs sharing the database never erase each other's.
- `store/engine.ts` pulls at boot, on focus, every minute and after a push. It pushes a
  quarter-second after a change, and at once (`keepalive`) when the tab hides. A call not
  answered in 30 s, body included, is given up and tried again. While an open post waits for its
  full text, or a new feed for its first fetch, the page pulls sooner (`lib/use-quick-pull.ts`):
  from 4 s, doubling to a minute, for two minutes at most, never while the tab is hidden, and for
  a feed only while its status is `active`.
- `store/objects.ts` serves bodies and translations from memory, then IndexedDB, then `/o/*`,
  downloading each once however many ask while it is on its way. Only a 404 is "no such
  object"; any other refusal rejects (`ObjectUnavailable`), and a copy the device will not keep
  (a full disk) is still shown. It prefetches unread bodies while idle, and ten seconds after
  boot evicts bodies not opened for seven days (found by key on the `lastOpened` index, never
  read), then the oldest past 50 MB, and the translation and chunk objects of every body no
  longer held, by key range. A post refused for the day's limit on blogs the member does not
  subscribe to (ADR 0066: a 429 for one object, or a key a bundle lists under `refused`) rejects
  with `PostRefused`, and is remembered in memory, for the account that asked, until `resetsAt`
  (a minute at least): nothing asks for it, or its translations, again before then, and it is
  not `missing`, so the reading page's ask-again loop leaves it alone. A change to the
  subscriptions forgets every refusal (`noteSubscriptions`). The prefetch, and the Up next body,
  take only posts from blogs the member subscribes to, which count against nothing.
- `store/selectors.ts` answers the reading view: unread, lists, counts, the title to show.
- The URL alone says which article is open (ADR 0017's rule, kept): a click, a filter change or
  Back is a render, not a request.
- `views/` are the front page, Discover, a blog's page, a profile, a blogroll's page and the info
  pages as pure components the edge renders too. What only the app adds (a blogroll's owner tools,
  each row's Remove and note editor, Subscribe to all) comes in through slots. `/` renders the
  front page while the session is unknown on a device that holds no account, so the edge's copy
  is never replaced by a blank page.
- Highlights: `lib/anchor.ts` finds a highlight again by leaf, quote and context;
  `lib/use-highlights.ts` paints them over the rendered text with the CSS Custom Highlight API and
  writes back an anchor the post moved. Typography and theme are synced prefs
  (`lib/typography.ts`); which panes show is this device's, in localStorage (`lib/layout.ts`,
  ADR 0029), as is which folders are open (`lib/folders-open.ts`, ADR 0048). `j`/`k`/`Esc`/`o`/`l`/`m`/`h`/`[`/`f`/`?` work on `/reading`.
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
| `/login` | Password first, or an emailed code (ADR 0043); the mail's sign-in and reset links fill their code in and ask before using it (ADR 0036), and a first sign-in's (`join=1`) asks for the joiner's password and goes on to Discover |
| `/reading?filter=&feed=&folder=&article=&mode=` | Sidebar, list and the open article; `folder` lists every blog in one of the member's folders (ADR 0048) |
| `/discover`, `/discover/articles?topic=&lang=&sort=new&cursor=`, `/discover/blogs?topic=&lang=&page=`, `/discover/blogrolls?cursor=`, `/discover/readers` | Discover (ADRs 0044, 0050): This week (the week's most recommended, else the edition; new blogs; readers to follow), Articles, Blogs, Blogrolls (public blogrolls of three blogs or more, newest public first, with why each is there worked out on the device: "Yours", or that the member follows its owner) and Readers. Public pages, rendered at the edge too; Articles' sorts and pages are cached apart. The device hides the blogs its member reads and matches suggested readers to their likes and blogs (`lib/discover-overlay.ts`, `lib/discover-week.ts`, `lib/suggest-readers.ts`) |
| `/s/:id`, `/@handle?tab=` | Public pages, rendered at the edge too; a profile's tabs are cached apart. A profile's Blogrolls tab shows a visitor its public blogrolls, and only when it has one; the member's own always shows it, from the device, private ones included, with New blogroll (ADR 0050) |
| `/l/:id` | A blogroll (ADR 0050). One the device holds is its owner's, rendered from the store, with who can see it (changed in Edit), Edit, Add blogs and Copy link, and Remove and a note on each row; one whose deletion is held is Not found; anyone else's comes from `/api/v1/public/blogrolls/:id`, with Subscribe to all and Subscribe on each row, or links to sign in for a visitor. Open to guests, rendered at the edge too; a malformed id is Not found with no request |
| `/about`, `/privacy`, `/terms` | The info pages, for anyone; copy from `src/content/info`, rendered at the edge too, with no data |
| `/following?tab=` | What the people a member follows did, by RPC; whom they follow, from the device (ADR 0031); readers to follow from Discover's pool, by the same rule (ADR 0044) |
| `/search?q=` | The device first, then blogs and older posts from the server |
| `/add`, `/claim?url=&taken=`, `/sites/:id/claim` | Add feeds and OPML; claim a blog (For writers' card lands on `/claim` with its blog filled in) |
| `/writers` | For writers: a calling card made as you type, beside a labelled sample (ADR 0037); SPA-only (ADR 0035) |
| `/settings/:section?` | Profile, Reading, Translation, Subscriptions (with OPML in and out; from `lg` up the manager of `components/subscriptions-manager.tsx`, below it the sections of `components/folders-manage.tsx`, ADR 0049; a folder makes a private blogroll of its blogs from either, ADR 0050), Privacy (with "Your data"), Connected apps (ADR 0064); Connected apps, Invites and Account read `/api/v1/connections`, `/api/v1/invites` and `/api/v1/account` live, not synced rows (`lib/apps-api.ts`, `lib/account-api.ts`). Bare `/settings` is the list of sections below `md` and goes to `/settings/profile`, Profile at every width, from it (ADR 0047) |
| `/dashboard` | The author's view |
| `/connect?client_id=&redirect_uri=&…` | Connecting an app (ADR 0064), the OAuth authorization endpoint: the request checked by tela-api, the app and what it asks for, Approve or Decline, then `location.assign` to the answer tela-api gives. A visitor signs in through the sheet and stays here (`STAY_PAGES`). SPA-only and out of `run_worker_first`, so its query reaches no Worker's logs; the plain shell says noindex |
| `/admin/:area?f=&q=&id=&sort=&dir=` | The admin console (ADR 0039), its own chunk loaded only when an admin opens it, reading tela-api over the network; anyone else sees Not found. The URL alone holds the area, filter, search, open record and sort |

## Sync (`packages/sync`, `packages/data/src/queries/sync.ts`, `apps/api/src/sync`, ADR 0025)

- One `seq` counter: every batch that writes a synced row bumps it and stamps its rows, so a
  device's cursor is simply the last seq it saw, and the server keeps nothing per device.
- The pull reads a member's own rows and the shared rows of the feeds they follow, plus the
  articles they keep (liked, recommended, highlighted) and the posts of feeds they follow that
  they marked unread, which beat the horizon (ADR 0009), in one batch. The members they follow
  come as their own rows, re-sent when a followee's profile changes; what those members do does
  not sync at all, and arrives by RPC (ADR 0031). The feed and site rows of every blog in the
  member's live blogrolls come too, subscribed or not, without their posts (`rolledFeeds` in a
  snapshot, `newlyRolled` in a delta), and the device keeps them when it prunes, so a blogroll
  still names a blog its owner left (ADR 0050).
- Titles come in the device's reading language only (ADR 0052). The pull names it
  (`&titles=<lang>`; a value outside the launch set gets every language, as naming none does,
  so a newer tela-web's new language never stops a sync), tela-api adds it to the
  fresh and the changed title query, pages end by that language's rows, and the answer says it
  back as `titlesLang`. A pull that names none gets every language and no `titlesLang`, as a
  protocol-3 shell expects, so the protocol stays at 3. When the reading language changes, the
  device drops the old language's titles, shows originals, and fetches the new one's for the
  posts it holds by id (`POST /api/v1/sync/titles`), instead of starting over.
- The push is guarded per mutation by `applied_mutations` and resolves conflicts by the later
  `at`, clamped to the server's clock. The privacy switches are the exception: a hide always
  applies, and a show only against the version in its device's confirmed rows, which waits while
  that device's own change to the switch is unsettled (ADR 0031, issue #16), and a blogroll's
  Public is the same (ADR 0050). A deletion wins over any later edit for highlights, folders and
  blogrolls; deleting a folder leaves its blogs in none, each keeping its move's clock (ADR 0048).
- Blogrolls (ADR 0050) are six mutations: `putBlogroll` (make one, or change its name and
  description; never revives a deleted one; `isPublic` only when it makes it), `setBlogrollPublic`
  (versioned, as above, never moving `updated_at`), `deleteBlogroll`, `rollBlog` (a blog put back
  goes to the end), `unrollBlog` (its clock moves forward even on a blog already out) and
  `noteBlog` (the note's own clock, so a note never puts back a blog taken out). Past their limits
  (50 blogrolls, 200 blogs) they write nothing and are acknowledged, as `putFolder` is; a control
  character is refused as `invalid_name` or `invalid_text`. The device's `view()` applies the
  pending and held mutations over one copy of the tables, not one copy each, which a held
  Subscribe to all of some 400 mutations made necessary.
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
  `global_fetch_strictly_public` refuses them at the socket too. The two hosts Tela names itself,
  Gravatar and GitHub's API, are asked with a plain `fetch`, and the GitHub token goes to that
  host only, on no redirect.
- **Model output is never trusted as HTML:** placeholders must match, text is re-escaped.
- **Every page carries security headers** (ADR 0051): a content security policy that names the
  one inline script by its hash (report-only while it proves itself), HSTS, `nosniff`, a referrer
  policy, a permissions policy and no framing.
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
- **The API host is bearer-only, and nothing else takes a bearer token** (ADRs 0064, 0065). Cookies
  are host-only, tela-gateway drops any that come and sets none, and tela-api's `/gateway/*`
  reads no session; every internal `/api/*` route refuses an app's token (a test walks Hono's
  route table). better-auth's `bearer` plugin is never enabled.
- **An app is never an admin:** its principal carries no admin flag, it reaches no admin route,
  and every shared rule is called for it with `exempt: false`, so an app acting for the operator is
  held to every member limit, the day's posts included.
- **Connections end with sessions:** every path that ends a member's other sessions ends their
  apps' connections and tokens in the same batch, and tokens are read from D1 on every call.
- **Content keys reach only members** (ADR 0066): no public answer carries one, and every object
  and image is decided by tela-api (`admitOpens`) before either edge serves it, from R2 or the
  colo's copy. Tokens, codes and member ids never go into a cache key as they are.
- **A small count is not published:** below three readers a blog's public count is null, and
  Discover orders it as none, so neither the number nor the order names who reads a blog an
  operator listed from the review queue (ADR 0041), and no public answer carries `listing`. A
  subscriber's device holds it only from three too (0 below), and a recount re-sends the row only
  when that changes.

## Tests

- `bun run test`: every package and app on the portable adapters (libSQL in memory, memory blobs
  and queues), including the convergence property test, the backup round trip that restores and
  serves from a fresh database, and the edge Worker with a fake cache.
- `bun run test:workers`: the data contract and tela-api's sign-in, push and pull on real D1 in
  workerd.
- `bun run e2e` (`apps/reader/e2e`): the built reader, tela-api and tela-jobs in one `wrangler dev`
  on fresh local D1, R2 and queues, and tela-gateway in a `wrangler dev` of its own beside it,
  against the fixture feed server. Test mode (`ENV=test`) adds
  the sign-in outbox, `POST /api/test/cycle`, which runs tela-jobs' sweeps to completion,
  because local dev fires no crons, and `POST /api/test/age`, which makes a profile older than
  the week a new account waits before Discover suggests it. Service workers are blocked there, except in the
  `shell-worker` project, where `redirect.e2e.ts` runs the real `public/sw.js` and tela-redirect's
  kill switch in Chromium on two local origins.
