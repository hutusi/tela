# Tela

Tela is a multilingual reader and gathering place for independent blogs. Readers subscribe to
blogs and personal websites; bloggers claim their feeds and see who reads them, which posts they
liked, and what they said when recommending them. LLM translation shows a post next to its
original, so anyone can read the world's indie blogs.

Every feed here has a specific human behind it.

## Layout

| Path | What it is |
|---|---|
| `apps/web` | Next.js 16 app (App Router, Tailwind v4, next-intl), deployed to Cloudflare Workers via OpenNext |
| `apps/worker` | Background worker: one codebase, roles selected by `WORKER_ROLES` (scheduler, fetch, extract, translate, assets, claim, relay) |
| `packages/db` | Drizzle schema, migrations, query helpers |
| `packages/content` | Pure content pipeline: feed discovery and parsing, sanitization, block ids, language detection |
| `packages/llm` | Translation provider adapter, prompts, validation |
| `packages/shared` | Constants and small helpers shared by web and worker |
| `docs/` | [Architecture](docs/ARCHITECTURE.md), [Operations](docs/OPERATIONS.md), [ADRs](docs/adr/) |

## Quick start

Prerequisites: Bun 1.3+, Node 22+, and a Postgres for tests (Homebrew `postgresql@17`, or Docker
with the Supabase CLI, or any database in `TEST_DATABASE_URL`).

```sh
bun install
bun run lint        # biome
bun run typecheck   # tsc in every workspace
bun run test        # bun test; DB tests start a throwaway local Postgres
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

## Status

Milestone 1 is under construction on the `feat/mvp` branch. See `docs/ARCHITECTURE.md` for the
target design and which parts exist yet.
