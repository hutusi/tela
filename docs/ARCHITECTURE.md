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

## Content pipeline [phase 2]

`packages/content`, pure TypeScript with no I/O:

1. Discovery: try the URL as a feed, then `link[rel=alternate]`, then common paths.
2. Parsing with `feedsmith` (RSS, Atom, RDF, JSON Feed, OPML).
3. Sanitize with `sanitize-html` (allowlist; no svg/iframe/script). Leaf-normalize so every
   text-bearing block is a leaf (`p, h1-h6, li, figcaption, th, td, dt, dd, summary, caption`).
4. Tagged text: inline markup becomes `<gN>…</gN>` and `<xN/>` placeholders; attributes are kept
   in a side table. The block id is the first 10 hex of
   `sha256(NFC(collapse_ws(trim(tagged_text))) + NORM_VERSION)`, written as `data-tb`.
5. Skip `pre`, `code`, `math`, and blocks with no translatable text.
6. Language detection (script heuristics, then `tinyld`), excerpt, reading time.
7. Image URLs stay original in storage and are rewritten to the signed `/img` proxy at render.

## Fetching [phase 3]

Scheduler enqueues `feed.fetch` for due feeds (singleton per feed). Adaptive interval from posting
cadence with jitter and header floors; conditional GET plus body hash; exponential backoff on errors;
301 rewrites; dead after 410 or 30 failures. Dedup ladder: guid → normalized link →
sha(title|published_at). Summary-only feeds are extracted lazily at first open.

## Translation [phase 5]

Provider-agnostic adapter (Vercel AI SDK); first provider is Aliyun Bailian's OpenAI-compatible
endpoint serving GLM. Targets are the reading languages in `packages/shared` (`zh-Hans`, `en`).
Title and excerpt are translated eagerly at ingest; bodies lazily on first open. One call per
chunk of ~3k source tokens returns `{ translations: [{ id, text }] }`; each block is validated
(placeholder multiset, length ratio, non-identity) and cached in `translations`.

## Queue [phase 3]

pg-boss v12 on the same Postgres (ADR 0004). Queues: `feed.discover`, `feed.fetch`,
`article.extract`, `translate.title`, `translate.body`, `site.assets`, `site.claim.verify`,
`maintenance.*`. One process; `WORKER_ROLES` filters which subscriptions start.

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

1. Scaffold + infra ← current
2. Content package
3. Ingestion worker
4. Reader web
5. Translation
6. Discover + sites + claim
7. Recommendations + profiles + dashboard
8. Hardening (relay, China checks, search, observability)
