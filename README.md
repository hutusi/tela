# Tela

Tela is a multilingual reader and gathering place for independent blogs. Readers subscribe to
blogs and personal websites; bloggers claim their feeds and see who reads them, which posts they
liked, and what they said when recommending them. LLM translation shows a post next to its
original, so anyone can read the world's indie blogs.

Every feed here has a specific human behind it.

Tela is in private testing: the site is at <https://tela.ainaive.com>, registration is closed,
and the way in is an invite.

## Layout

| Path | What it is |
|---|---|
| `apps/reader` | The reader, deployed as `tela-web`: a Vite + React SPA that renders from the device and syncs behind, and the edge Worker that serves it (content objects, image proxy, public pages, the `/api` forward) |
| `apps/api` | The `tela-api` Worker: sign-in, sync, mutations and reader RPCs, pinned beside D1 |
| `apps/jobs` | The `tela-jobs` Worker: cron sweeps claim due work under leases, queues fan it out, jobs run pinned beside D1; upkeep, backups, the health check and the weekly digest |
| `apps/relay` | The China fetch relay: a signed fetch endpoint for an HK or mainland box, the one Node process Tela would run. Not provisioned until a feed needs it |
| `packages/platform` | The seams (Db, Blobs, Jobs, Clock, Mail) with Cloudflare and portable adapters (ADRs 0020, 0021) |
| `packages/data` | The SQLite data model for D1 and libSQL: schema, migrations, leases, the sync sequence, queries, the nightly export |
| `packages/sync` | The sync protocol between the reader and tela-api, and the device's reducer |
| `packages/content` | The content pipeline: feed parsing, sanitization, block ids and hashing, content objects |
| `packages/ingest` | Fetching: HTTP client, feed discovery, the ingest pipeline, region routing, WebSub |
| `packages/llm` | Translation provider adapter, prompts, validation |
| `packages/shared` | Constants and small helpers shared everywhere |
| `packages/config` | Shared tsconfig bases |
| `docs/` | [Architecture](docs/ARCHITECTURE.md), [Operations](docs/OPERATIONS.md), [Design](docs/DESIGN.md), [ADRs](docs/adr/) |

## Quick start

Prerequisites: Bun 1.4+ and Node 24+ (wrangler is a Node CLI). Nothing else: the tests run on
libSQL in memory and on D1 inside workerd.

```sh
bun install
bun run lint          # biome
bun run typecheck     # tsc in every workspace
bun run test          # bun test, on the portable adapters
bun run test:workers  # the data contract and the API again, on D1 inside workerd
bun run e2e           # Playwright against the three Workers in one wrangler dev
bun run dev           # the reader with tela-api and tela-jobs beside it; see docs/OPERATIONS.md
```

## Features

- **Reader**: every screen renders from the device, so opening a post, changing a filter or
  going back never waits on the network; unread bodies are prefetched while idle, and a repeat
  visit paints from a cached shell. Subscribe by URL or OPML, unread counts, smart filters (all /
  today / liked), mark read and mark all read, likes.
- **Translation**: titles translated eagerly, bodies on open and streamed in as they are
  translated; side-by-side / translation / original modes aligned block by block, a "Read in"
  language switch, and a content-addressed cache so nothing is translated twice. Providers are
  pluggable (Aliyun Bailian GLM first, Anthropic second, a mock for tests).
- **Highlights and notes**: private, on either side of a translation, and found again when the
  post is edited.
- **Reading comfort**: text size, line length and a dark theme, synced across devices; `j`/`k`
  to move through the list and `Esc` to close.
- **Discover**: listed blogs with topic and language filters, blog pages, subscribe from a card.
  A blog gets there three ways: an editorial pick, its author claiming it, or three distinct
  members subscribing to it.
- **Claim your feed**: prove ownership with a meta tag or `rel="me"` link; claimed blogs are
  listed and can opt out of translation.
- **Recommendations**: recommend a post with a note; the note appears on your public profile
  (`/@handle`) and in the author's dashboard next to likes and reader counts.
- **Search**: the device first, then blogs by name, address or description and older posts in your
  subscriptions by original or translated title.
- **Freshness**: adaptive polling with conditional requests, plus WebSub push where a feed
  advertises a hub.
- **Running unattended**: a dead-man's switch, a weekly digest, a verified nightly export that
  restores anywhere SQLite runs, and D1's point-in-time recovery.
- **UI languages**: English and Simplified Chinese, switchable without a reload.

## Status

The local-first stack (three Cloudflare Workers, D1, R2 and Queues) is built and tested, and
replaces the Postgres app at the cutover in `docs/OPERATIONS.md`. See `docs/ARCHITECTURE.md` for
the design, `docs/OPERATIONS.md` for how it is provisioned and run, and `CHANGELOG.md` for what
has shipped.
