# Tela

Tela is a multilingual reader and gathering place for independent blogs. Readers subscribe to
blogs and personal websites; bloggers claim their feeds and see who reads them, which posts they
liked, and what they said when recommending them. LLM translation shows a post next to its
original, so anyone can read the world's indie blogs.

Every feed here has a specific human behind it.

Tela is in private testing: the site is live at <https://tela.ainaive.com>, but signup is closed
and the way in is an admin invite.

## Layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js 16 app (App Router, Tailwind v4, next-intl), deployed to Cloudflare Workers via OpenNext |
| `apps/worker` | Background worker: one codebase, roles selected by `WORKER_ROLES` (scheduler, fetch, extract, translate, assets, claim, relay) |
| `apps/jobs` | The `tela-jobs` Worker: cron sweeps claim due work under leases, queues fan it out, jobs run pinned beside D1 (refactor/local-first) |
| `apps/api` | The `tela-api` Worker: sign-in, sync, mutations and reader RPCs, pinned beside D1 (refactor/local-first) |
| `apps/relay` | The China fetch relay: a signed fetch endpoint for an HK or mainland box, the one Node process Tela would run. Not provisioned until a feed needs it (refactor/local-first) |
| `packages/db` | Drizzle schema, migrations, query helpers, the job sender |
| `packages/content` | Pure content pipeline: feed parsing, sanitization, block ids and hashing, language detection |
| `packages/ingest` | Ingestion library: HTTP client, feed discovery, fetching, article extraction, region routing, WebSub |
| `packages/llm` | Translation provider adapter, prompts, validation |
| `packages/shared` | Constants and small helpers shared by web and worker |
| `packages/config` | Shared tsconfig bases |
| `packages/platform` | Platform seams (Db, Blobs, Jobs, Clock, Mail) with Cloudflare and portable adapters; being built on `refactor/local-first` (ADRs 0020, 0021) |
| `packages/data` | SQLite data model for D1 and libSQL (schema, migrations, leases, sync sequence); replaces `packages/db` at cutover |
| `docs/` | [Architecture](docs/ARCHITECTURE.md), [Operations](docs/OPERATIONS.md), [ADRs](docs/adr/) |

## Quick start

Prerequisites: Bun 1.4+, Node 24+, and a Postgres for tests (Homebrew `postgresql@17`, or Docker
with the Supabase CLI, or any database in `TEST_DATABASE_URL`).

```sh
bun install
bun run lint        # biome
bun run typecheck   # tsc in every workspace
bun run test        # bun test; DB tests start a throwaway local Postgres
bun run test:workers  # the data contract again, on D1 inside workerd
bun run e2e         # Playwright against a built app, worker, and fixture feeds

# web (no Supabase project needed locally: dev-auth mode + a local Postgres)
bun run db:local --port 54322            # migrated Postgres with the development user
cp apps/web/.env.example apps/web/.env   # DATABASE_URL matches the port above; TELA_DEV_AUTH=1
bun run dev                              # http://localhost:3000

# worker
cp apps/worker/.env.example apps/worker/.env
bun run dev:worker

# database
bun run db:generate                       # drizzle-kit generate from packages/db/src/schema
DATABASE_URL=... bun run db:migrate       # apply packages/db/migrations
```

## Features

- **Reader**: subscribe by URL or OPML, unread counts, smart filters (all / today / liked), mark read
  and mark all read, likes, a three-column layout that mirrors the design.
- **Translation**: eager title translation, lazy body translation on open, side-by-side /
  translation / original modes aligned block by block, a "Read in" language switch, and a
  content-addressed cache so nothing is translated twice. Providers are pluggable (Aliyun Bailian
  GLM first, Anthropic second, a mock for tests).
- **Discover**: listed blogs with topic and language filters, site pages, subscribe from a card.
  A blog gets there three ways: an editorial pick, its author claiming it, or three distinct
  members subscribing to it.
- **Claim your feed**: prove ownership with a meta tag or `rel="me"` link; claimed sites are listed
  and can opt out of translation.
- **Recommendations**: recommend a post with a note; the note appears on your public profile
  (`/@handle`) and in the author's dashboard next to likes and reader counts.
- **Settings**: handle, display name, bio, public subscriptions, reading language, OPML export.
- **Search**: blogs by name, address, or description and posts in your subscriptions by original
  or translated title (trigram indexes, works for CJK).
- **Freshness**: adaptive polling with conditional requests, plus WebSub push where a feed
  advertises a hub.
- **Reachability**: feeds that keep timing out are fetched through a signed relay in Hong Kong or
  mainland China and re-probed directly every week.
- **Operations**: hourly abuse limits on discovery, imports, and claims; a five-minute health
  check that logs queue depth, dead letters, and overdue feeds; a stacked mobile layout.
- **UI languages**: English and Simplified Chinese, switchable without a page reload.

## Status

Milestone 1 is done and deployed. All eight roadmap phases are implemented and tested (unit,
database, worker integration, and Playwright end-to-end); the web app runs on Cloudflare Workers
at <https://tela.ainaive.com>, the worker runs every role on Fly.io in Tokyo, and translation
runs against Aliyun Bailian.

Signup is closed while Tela is in private testing, and the site is kept out of search indexes.
Opening up is two switches, both named in the runbook. See `docs/ARCHITECTURE.md` for the design
and the route map, `docs/OPERATIONS.md` for how it is provisioned and run, and `CHANGELOG.md` for
what has shipped.
