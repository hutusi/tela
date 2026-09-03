# Tela — conventions for agents and humans

Read `docs/ARCHITECTURE.md` for the design and `docs/adr/` for why. `apps/web/AGENTS.md` carries
Next.js 16 rules that differ from older training data; read it before touching `apps/web`.

## Commands

- `bun install` — workspaces: `apps/*`, `packages/*`
- `bun run lint` / `bun run lint:fix` — Biome (format + lint), config in `biome.json`
- `bun run typecheck` — `tsc -p` in every workspace (all `noEmit`)
- `bun run test` — `bun test`; DB tests need `initdb` on PATH, `PG_BIN_DIR`, or `TEST_DATABASE_URL`
- `bun run dev` (web), `bun run dev:worker` (worker on Bun for dev; Node 22 in production)
- `bun run db:generate` then commit `packages/db/migrations/*`; `bun run db:migrate` applies them
- `cd apps/web && bun run preview` — OpenNext build + local Workers runtime

## Invariants

- **Runtime-agnostic packages.** No `Bun.*` APIs in `packages/*` or `apps/worker` source; the
  worker runs on Node 22 in production (Bun bundles it: `apps/worker/Dockerfile`).
- **Cloudflare-specific code lives only in `apps/web/src/lib/platform/`.** Everything else in the
  web app must run unchanged on Vercel or a Node container.
- **Migrations via `drizzle-kit generate`, never `push`.** Custom SQL (triggers, functions) goes
  in `drizzle-kit generate --custom` files. RLS policies are declared in the schema with `pgPolicy`.
- **`NORM_VERSION` (packages/shared) must be bumped** whenever block normalization, placeholder
  grammar, or hashing rules in `packages/content` change. It is part of every block hash.
- **Jobs are idempotent.** Re-running any worker job must not duplicate rows or re-translate cached blocks.
- **Never interpolate numbers or identifiers into `sql\`\`` for DDL** without `sql.raw(...)`; drizzle
  turns interpolations into `$1` parameters (see the `recommendations_note_length` check).
- **Reading languages are the launch set in `packages/shared/src/languages.ts`**; never translate into
  "every language a subscriber speaks".
- **Use absolute paths in shell commands.** The shell's working directory persists between commands.

## Style

- TypeScript strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. No enums: use `as const` unions.
- Single quotes, no semicolons, trailing commas (Biome).
- Test files are `*.test.ts` next to the code or under `test/`; Playwright specs are `*.e2e.ts`.
- Conventional Commits; the body explains why. No Co-Authored-By or AI-attribution trailers.

## How to

- **Add a table**: edit `packages/db/src/schema/*.ts` (add `pgPolicy` rows and `.enableRLS()` if no
  policy), `bun run db:generate`, review the SQL, add a test in `packages/db/test/`.
- **Add a worker job**: put the logic in `packages/ingest` (pure library, tested with the fixture
  HTTP server + DB harness), declare the queue and its payload type in `apps/worker/src/queues.ts`,
  add a thin handler under `apps/worker/src/jobs/`, and subscribe it under the right role in
  `apps/worker/src/index.ts`. Roles live in `apps/worker/src/roles.ts`.
- **Run ingestion by hand**: `DATABASE_URL=… bun run worker:once fetch <feedUrl>`; `bun run
  db:local --port 54322` gives you a migrated Postgres without Docker.
- **Add a UI string**: `apps/web/messages/en.json` and `zh-Hans.json`, same key in both.
- **Add a reading language**: `READING_LANGUAGES` in `packages/shared`, a message catalog if it is
  also a UI locale, and `LANGUAGE_NAMES`.
