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
   fetch ──(fetch_region=cn)──▶ relay role on a HK/CN box (HMAC-signed fetch endpoint)  [phase 8]
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

Row-level security is enabled on every table. Content tables are readable by `anon` and
`authenticated`; user tables are owner-only via `(select auth.uid())`; writes happen through the
service connection. Application code is the authority; RLS is the backstop (ADR 0003).

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

## Translation [phase 5]

Provider-agnostic adapter (Vercel AI SDK); first provider is Aliyun Bailian's OpenAI-compatible
endpoint serving GLM. Targets are the reading languages in `packages/shared` (`zh-Hans`, `en`).
Title and excerpt are translated eagerly at ingest; bodies lazily on first open. One call per
chunk of ~3k source tokens returns `{ translations: [{ id, text }] }`; each block is validated
(placeholder multiset, length ratio, non-identity) and cached in `translations`.

## Queue

pg-boss v12 on the same Postgres, schema `pgboss` (ADR 0004). `apps/worker/src/queues.ts`
declares every queue with its policy, retries, expiry, and a `<name>.dead` dead-letter queue:

| Queue | Producer | Role | Notes |
|---|---|---|---|
| `scheduler.tick` | cron `* * * * *` | scheduler | enqueues `feed.fetch` for due feeds (singleton per feed) |
| `maintenance.daily` | cron `17 3 * * *` | scheduler | revives dead feeds once a week |
| `feed.fetch` | scheduler | fetch | `short` policy, 3 retries with backoff, 120 s expiry |
| `article.extract` | web (first open) [phase 4] | extract | lazy full-text extraction |
| `translate.title`, `translate.body` | fetch / web [phase 5] | translate | declared, not consumed yet |
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
  (EB Garamond, Figtree) are self-hosted by `next/font`.
- Routes [phase 4+]: `/reading`, `/discover`, `/add`, `/s/[siteId]`, `/@[handle]`,
  `/sites/[id]/claim`, `/dashboard`, `/settings`, `/login`, `/img`.

## Roadmap (milestone 1, branch `feat/mvp`)

1. Scaffold + infra ✓
2. Content package ✓
3. Ingestion worker ✓ (site assets to R2 moved to phase 6, where Discover first shows favicons)
4. Reader web ← current
5. Translation
6. Discover + sites + claim
7. Recommendations + profiles + dashboard
8. Hardening (relay, China checks, search, observability)
