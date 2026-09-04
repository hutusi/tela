# Tela architecture

Tela is a multi-user, multilingual RSS reader whose identity is "every feed here has a human behind
it". This document is the living map of the system; decisions and their reasons are in `adr/`.
Sections are tagged with the phase that implements them (see "Roadmap"); anything untagged exists.

## Topology

```
Browser ──HTTPS──▶ Cloudflare Worker (Next.js via OpenNext)
                     ├─ Hyperdrive ──▶ Supabase Postgres (Tokyo, direct connection) ◀── worker(s)
                     ├─ /img signed image proxy (Cache API) ──▶ origin images          [phase 4]
                     └─ Supabase Auth (browser: @supabase/ssr)                          [phase 4]
Worker image (Node 22, Fly.io nrt), WORKER_ROLES selects subscriptions:
   scheduler | fetch | extract | translate | assets | claim ──▶ Postgres (pg-boss + data) [phase 3+]
   fetch ──(fetch_region=cn)──▶ relay role on a HK/CN box (HMAC-signed fetch endpoint)  [phase 8 ✓]
   translate ──▶ Aliyun Bailian (GLM) or other providers through one adapter           [phase 5]
   assets ──▶ R2 (S3 API), served from assets.<domain>                                  [phase 3]
```

## Monorepo

```
apps/web            Next.js 16 App Router, Tailwind v4, next-intl (no i18n routing), Drizzle server-side
apps/worker         Node 22 process bundled by Bun; src/roles.ts, src/config.ts, src/index.ts
packages/db         Drizzle schema (src/schema/*.ts), migrations/, client.ts, test/ harness
packages/content    pure TS content pipeline                                            [phase 2]
packages/llm        translation adapter                                                 [phase 5]
packages/shared     constants (languages, topics, NORM_VERSION, enums), helpers
packages/config     shared tsconfig bases
```

Bun is the package manager, script runner, and test runner. Node 22 LTS is the production runtime
for the worker (ADR 0001). The web app is deployed to Cloudflare Workers through OpenNext and kept
free of Cloudflare bindings outside `apps/web/src/lib/platform/` (ADR 0002).

## Data model

Tables live in `packages/db/src/schema/`. bigint identity ids on high-volume tables; uuid for users.

| Table | Role |
|---|---|
| `profiles` | One per auth user, created by the `on_auth_user_created` trigger. `handle`, `ui_locale`, `reading_lang`. |
| `sites` | A blog: normalized `home_url`, `listing` (private/listed/featured/rejected), `claimed_by`, `topics[]`, `reader_count`. |
| `feeds` | The fetch unit: `feed_url`, validators (`etag`, `last_modified`, `last_body_hash`), scheduling (`next_fetch_at`, `fetch_interval_sec`), `fetch_region`, `status`, `content_mode`. |
| `articles` | Metadata: `dedup_key` (unique per feed), `source_lang`, `content_hash`, counters. `id` order is ingest order. |
| `article_contents` | Sanitized `html` with `data-tb` block ids, `blocks` summary. |
| `translations` | Content-addressed cache keyed by `(source_hash, target_lang)`; stores tagged text. |
| `article_translations` | Per article and target language: status, translated title/excerpt, materialized `html`, `failed_block_ids`. |
| `subscriptions` | `(user_id, feed_id)` with `watermark_id`: everything at or below it is read. |
| `user_article_states` | `read_at`, `liked_at` per user and article. |
| `recommendations` | Public recommendation with an optional note (≤ 500 chars). |
| `site_claims` | Claim attempts: method (meta / rel_me / dns), token, status. |
| `llm_usage` | One row per LLM call for budget and cost visibility. Service-only. |
| `rate_limits` | Fixed-window counters per action and member (`consumeRateLimit`). Service-only. |
| `websub_subscriptions` | One per feed with a hub: topic, shared secret, status (pending/active/failed), lease. Service-only. |

Row-level security is enabled on every table and every policy is a `select`: members read all
content tables, anonymous callers only the rows of `listed`/`featured` sites, and user tables are
owner-readable via `(select auth.uid())`. No policy grants a write, so the Supabase Data API can
never bypass the counters, rate limits, and handle rules that live in application code; all
writes go through the service connection, which is the authority (ADR 0003).

Unread count per feed = `articles.id > watermark_id AND fetched_at > now() - 30 days AND NOT EXISTS
read row`. "Mark all read" moves the watermark and compacts read rows below it.

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
   `sha256(normalized tagged text + NORM_VERSION)`.
5. Tagged text (`toTaggedText` / `fromTaggedText` / `checkPlaceholders`): inline markup becomes
   `<gN>…</gN>` and `<xN/>` placeholders; rehydration re-escapes model output.
6. Skip `pre` and blocks with no letters or under two characters (`data-tb-skip`).
7. `detectLanguage` (script ratios, then tinyld), `makeExcerpt`, `readingMinutes`, `contentHash`.
8. Images stay original in storage; `rewriteImages` + `signImageUrl` produce `/img` proxy URLs at
   render time. `extractArticle` (`@tela/content/extract`, Readability on linkedom) recovers full
   text for summary-only feeds.

Fixtures: 21 captured real feeds in `packages/content/fixtures/`; snapshot tests pin block ids
and hashes for three articles as the `NORM_VERSION` contract.

## Ingestion (`packages/ingest` + `apps/worker`)

`packages/ingest` is the library (HTTP client, discovery, feed fetch, extraction) and is
runtime-agnostic so the web app can reuse discovery; `apps/worker` only wires it to pg-boss.

- `createHttpClient`: conditional headers, manual redirects with permanent-redirect detection,
  5 MB cap, charset-aware decoding, 2 s per-host spacing, private-network blocking, and a relay
  hook for `fetch_region = cn`.
- `createRelayHandler` / `createRelayClient` (`relay.ts`): the China fetch relay. The handler is
  Web-API only (served by Node `http` in the `relay` role); the client signs each hop with
  HMAC-SHA256 over a timestamp and the JSON body and rebuilds a `Response`. See ADR 0008.
- `region.ts`: a feed flips to the relay on its third consecutive timeout when the control URL
  still answers, and is re-probed from the global region after seven days (`maintenance.daily`).
- `websub.ts`: WebSub subscriber side. Feeds that advertise a hub (`rel="hub"`, JSON Feed
  `hubs`) get a subscription request with a per-feed secret; the web callback
  (`/api/websub/[feedId]`) answers the hub's intent check and, for signed content pings, enqueues
  a normal `feed.fetch` rather than trusting the pushed body. Leases (10 days) renew from the
  daily maintenance job two days before they end. Polling continues regardless, so a hub outage
  only costs freshness.
- `discoverFeeds(http, url)`: the URL itself, then feeds declared by the page, then well-known
  paths; every result is fetched and parsed before being returned.
- `ensureFeed` / `ensureSite`: feed rows keyed by `feed_url`, sites keyed by normalized origin;
  new feeds are due immediately, so the next scheduler tick fetches them.
- `fetchFeed(db, http, feedId)`: conditional GET → body-hash short-circuit → parse → upsert
  articles by dedup key (new rows, or `content_version + 1` when the content hash changed) → fill
  site metadata → learn `content_mode` from three samples → reschedule. Interval = half the
  average gap between posts over 7 days, clamped to 30 min…24 h, ×1.5 when unchanged, raised to the
  publisher's `ttl`/`max-age` floor, ±10% jitter. Errors back off `interval × 2^n` capped at 7 days;
  429/503 honor `Retry-After`; 410 or 30 consecutive errors mark the feed dead; only
  timeouts/resets bump `timeout_streak` (the future cn-flip signal). Permanent redirects
  rewrite `feed_url`.
- `extractArticleContent` (`@tela/ingest/extract`): fetches the article page, runs Readability,
  and replaces the stored content only when the result is clearly longer.

Tests run against an in-process fixture HTTP server and the DB harness
(`packages/ingest/test/`).

## Translation (`packages/llm` + `apps/worker/src/translation`)

ADR 0006. `packages/llm` is the provider adapter: a `Translator` interface with Bailian
(OpenAI-compatible, GLM), Anthropic, and a deterministic mock behind `createTranslator` /
`configFromEnv`; `translateBlocks` chunks to ~3k source tokens, validates every block
(placeholder multiset, length ratio, non-identity), retries failures once in strict mode, and
carries the previous chunk's tail as context.

- **Eager titles**: after each fetch the worker sends `translate.title` for new and changed
  articles into every reading language ≠ source; `translateArticleTitle` stores the result on
  `article_translations.title/excerpt` with `status = 'pending'` (body untouched).
- **Lazy bodies**: opening a foreign article calls `requestTranslationAction`, which upserts
  `status = 'requested'` (or notices a fresh `done`/`partial` row) and sends `translate.body` at
  priority 10; the reader polls every 2 s. `translateArticleBody` reads `taggedTextsOf(html)`,
  looks up the `translations` cache by block hash, translates only the misses, stores them, and
  materializes the rehydrated HTML. Same-language, opted-out, and budget-exhausted cases are
  recorded as `done`/`failed`/skipped explicitly.
- **Reader**: `TranslationBar` (written in X, translated by Tela, status) with Side by side /
  Translation / Original modes (`?mode=`); the list shows translated titles and excerpts and an
  `XX → YY` badge. "Read in" in the header sets `profiles.reading_lang`.
- **Cost**: `llm_usage` per call; `LLM_DAILY_BUDGET_TOKENS` gates background work (title jobs
  defer to the next day on a cache miss once it is spent); reader requests carry `onDemand: true`
  in the job payload and are rate-limited per member (`translate`, 120 per hour) instead.

## Queue

pg-boss v12 on the same Postgres, schema `pgboss` (ADR 0004). `apps/worker/src/queues.ts`
declares every queue with its policy, retries, expiry, and a `<name>.dead` dead-letter queue:

| Queue | Producer | Role | Notes |
|---|---|---|---|
| `scheduler.tick` | cron `* * * * *` | scheduler | enqueues `feed.fetch` for due feeds (singleton per feed) |
| `maintenance.daily` | cron `17 3 * * *` | scheduler | revives dead feeds once a week, re-probes relay-routed feeds, prunes rate-limit windows |
| `health.check` | cron `*/5 * * * *` (and at startup) | scheduler | logs queue depth, dead letters, failures in the last hour, and overdue feeds; `warn` level when something needs a look |
| `feed.fetch` | scheduler, web (add feed) | fetch | `short` policy, 3 retries with backoff, 120 s expiry |
| `article.extract` | web (first open) | extract | lazy full-text extraction for summary-only feeds |
| `translate.title` | fetch (in the article's own transaction; at most 100 articles per fetch) | translate | batches of 5, 4 in flight; every reading language the article is not in; deferred to the next day when the budget is spent |
| `translate.body` | web (open, same transaction as the `requested` row), scheduler (re-sends rows stuck `requested` for 5 min) | translate | priority 10 with `onDemand: true`; singleton per article and language |
| `websub.subscribe` | fetch (feed advertises a hub), maintenance (renewals) | fetch | asks the hub to push to `/api/websub/<feedId>`; only when `WEBSUB_ENABLED=1` |
| `site.assets` | fetch [phase 6] | assets | favicons and covers to R2 |
| `site.claim.verify` | web [phase 6] | claim | claim verification |

One process; `WORKER_ROLES` filters which `boss.work()` subscriptions start. Feed discovery runs
in the request path (web) or the CLI rather than through a queue. `bun run worker:once
<discover|fetch|extract> <arg>` runs any step directly against `DATABASE_URL`.

## Web app

- Data access: Drizzle + postgres.js on the server. `lib/platform/db.ts` reads the Hyperdrive
  binding on Cloudflare (one client per request) and `DATABASE_URL` elsewhere.
- i18n: next-intl without routing; locale from cookie → `Accept-Language` (ADR 0010).
  `reading_lang` is separate from the UI locale.
- Design tokens from `Tela.dc.html` live in `apps/web/src/app/globals.css` (`@theme`). Fonts
  (EB Garamond, Figtree) are self-hosted by `next/font`. See `docs/DESIGN.md`.
- Auth: `lib/auth.ts` (Supabase SSR cookies, `getClaims()`, dev-auth mode; ADR 0012). Pages call
  `requireUser()`. `src/middleware.ts` runs before every non-static request and refreshes an expiring
  session, forwarding the rotated cookies to both the render and the browser: Server Components
  cannot write cookies, and with refresh-token rotation a dropped refresh logs the reader out.
- Reader queries live in `packages/db/src/queries/reader.ts` (`listSubscriptions`, `countTotals`,
  `listArticles` with keyset paging, `getArticle`, `markRead`, `markAllRead`, `toggleLike`,
  `subscribe`) and are tested in `packages/db/test/reader.test.ts`.
- Enqueueing from the web: `createJobSender(db)` (`@tela/db/queue`) inserts into `pgboss.job`
  with plain SQL that mirrors pg-boss's own insert plan (queue defaults from `pgboss.queue`,
  `ON CONFLICT DO NOTHING` for singleton dedup). The web app never imports pg-boss, whose `pg`
  dependency does not bundle for Workers; `packages/db/test/queue.test.ts` fetches those rows with
  a real pg-boss instance so a schema change in pg-boss fails there first. "Add a feed" sends
  `feed.fetch`, and the reading view auto-refreshes until the first fetch lands.

| Route | Status | Purpose |
|---|---|---|
| `/` | ✓ | landing for anonymous users; signed-in users go to `/reading` |
| `/login`, `/auth/callback` | ✓ | email code, GitHub, Google; dev-auth button locally |
| `/reading?filter=&feed=&article=` | ✓ | three-column reader; URL carries the selection |
| `/add` | ✓ | discover feeds from any URL, subscribe, OPML import |
| `/img` | ✓ | signed image proxy (ADR 0007) |
| `/discover?topic=&lang=` | ✓ | listed and featured sites with topic chips, language menu, subscribe toggles, claim banner |
| `/s/[siteId]` | ✓ | public site page: avatar, description, readers, claimed badge, topics (owner-editable), latest posts |
| `/claim`, `/sites/[id]/claim` | ✓ | find the feed, then verify by meta tag or rel=me (ADR 0011) |
| `/@[handle]` | ✓ | public profile: sites written, recommendations with notes, subscriptions when public (root `[handle]` segment, only `@…` matches) |
| `/dashboard` | ✓ | author view: claimed sites, readers, per-post likes and recommendations, notes, translation opt-out |
| `/settings`, `/settings/opml` | ✓ | handle, display name, bio, public subscriptions, reading language, OPML export |
| `/search?q=` | ✓ | header search: listed sites (plus the member's private ones) by name, host, or description, and posts in the member's subscriptions by original or translated title |

### Safeguards

- **Abuse limits** (`rate_limits`, `consumeRateLimit` in `@tela/db/queries`): fixed hourly
  windows per member for feed discovery (30), subscribing (120), OPML import (5), claim start (10)
  and claim verification (30). Counters live in Postgres because the web app runs as stateless
  isolates; the worker's daily maintenance job prunes closed windows. Actions answer with a
  `rate_limited` message rather than an error page.
- **Search** uses `pg_trgm` GIN indexes on `sites.title`, `sites.home_url` and `articles.title`
  (migration 0007) so `ILIKE '%term%'` stays an index scan and site matches rank by
  `similarity()`. Trigrams handle CJK substrings without a tokenizer; PGroonga is the upgrade
  path when full-text ranking is needed.
- **Outbound fetches** from the web app (discovery, claim start) use the same HTTP client as the
  worker: private ranges refused, 10 s timeout, 5 MB cap. The worker additionally pins every
  connection to the addresses it resolved and refuses names that resolve to a private address
  (`apps/worker/src/net/safe-fetch.ts`); on Cloudflare the `global_fetch_strictly_public` flag
  plays that role, and the image proxy checks the host name as well.

## Roadmap (milestone 1, branch `feat/mvp`)

1. Scaffold + infra ✓
2. Content package ✓
3. Ingestion worker ✓ (site assets to R2 moved to phase 6, where Discover first shows favicons)
4. Reader web ✓
5. Translation ✓
6. Discover + sites + claim ✓ (site assets job included)
7. Recommendations + profiles + dashboard ✓
8. Hardening ✓ (China fetch relay with automatic region routing, rate limits, search, health
   checks, WebSub, mobile fallback)

Milestone 1 merges to `main` once the deploy-side checks in `docs/OPERATIONS.md` pass: a
Cloudflare preview through Hyperdrive, one real Bailian translation run, and the China smoke test
from the relay box (custom auth domain and image proxy reachability).
