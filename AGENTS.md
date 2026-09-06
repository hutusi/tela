# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, …) working in this repository. This
file is the single source of truth — CLAUDE.md imports it.

## Project

Tela is a multilingual reader and gathering place for independent blogs. Readers subscribe to
blogs and personal websites; bloggers claim their feeds and see who reads them. LLM translation
shows a post next to its original, block by block, so anyone can read the world's indie blogs.
Bun workspaces, TypeScript throughout; Next.js 16 on Cloudflare Workers for the web, a Node 22
container for the worker, Supabase Postgres underneath.

Product decisions that look odd but are deliberate:

- **Tela is in private beta.** Signup is closed at the platform level (`enable_signup = false` in
  `supabase/config.toml`, pushed so a Dashboard change cannot drift), and while
  `TELA_PRIVATE_BETA` is set in `apps/web/wrangler.jsonc` robots.txt disallows every crawler and
  pages carry `noindex`. The way in is an admin invite, which still works with signup off. Invite
  codes were deliberately not built: their design should follow how we decide to open up (ADR
  0015).
- **Reading languages are a fixed launch set** (`READING_LANGUAGES` in `packages/shared`), never
  "every language a subscriber speaks". Translation cost is bounded by the set, not by the
  audience (ADR 0006).
- **Titles translate eagerly, bodies lazily.** A reader who never opens a post never pays for its
  body. Body translation starts when the article is opened and is metered per member (ADR 0006).
- **The web app must run unchanged off Cloudflare.** Bindings live only in
  `apps/web/src/lib/platform/`; everything else would run on Vercel or a Node container as-is
  (ADR 0002). This is not hypothetical caution — it is what keeps the app testable without
  `wrangler`.
- **The worker is one image, not six services.** `WORKER_ROLES` selects which queues a process
  subscribes to. `relay` is special: it serves only the signed HTTP fetch endpoint and never
  touches the database.
- **The custom domain is the only public origin.** `workers.dev` is off on purpose — it is
  blocked in mainland China, so a `workers.dev` URL is a dead link for part of the audience.

## Repo map

| Path | What |
| --- | --- |
| `packages/content` | **The content contract — keystone.** Sanitization, block normalization, tagged-text placeholders, block hashing. `packages/content/README.md` is the normative spec; changing a rule means bumping `NORM_VERSION` |
| `packages/shared` | Constants shared by web and worker: languages, topics, `NORM_VERSION`, enums |
| `packages/db` | Drizzle schema (`src/schema/*.ts`), `migrations/`, query helpers, the job sender, the test harness |
| `packages/ingest` | Ingestion library: HTTP client, feed discovery, feed fetch, article extraction, region routing, WebSub. No queue, no runtime-specific APIs |
| `packages/llm` | Translation provider adapter, prompts, output validation |
| `packages/config` | Shared tsconfig bases |
| `apps/web` | Next.js 16 App Router, Tailwind v4, next-intl (no i18n routing), Drizzle server-side. Deployed to Cloudflare Workers via OpenNext |
| `apps/worker` | Node 22 process bundled by Bun. `src/roles.ts`, `src/queues.ts`, `src/jobs/`, `src/index.ts` |

## Commands

```sh
bun install                          # workspaces: apps/*, packages/*
bun run lint                         # Biome (format + lint), config in biome.json
bun run lint:fix                     # auto-fix
bun run typecheck                    # tsc -p in every workspace (all noEmit)
bun run test                         # bun test; DB tests need initdb on PATH, PG_BIN_DIR, or TEST_DATABASE_URL
bun run e2e                          # Playwright against a built app, worker, and fixture feeds
bun run build                        # build every workspace that has a build script
bun run dev                          # web (http://localhost:3000)
bun run dev:worker                   # worker on Bun for dev; Node 22 in production
bun run db:generate                  # drizzle-kit generate; then commit packages/db/migrations/*
bun run db:migrate                   # apply migrations (DATABASE_URL=…)
bun run db:local --port 54322        # migrated Postgres with the development user, no Docker
bun run db:prepare                   # apply that same setup to an existing database
bun run worker:once fetch <feedUrl>  # run one job by hand (DATABASE_URL=…)
cd apps/web && bun run preview       # OpenNext build + local Workers runtime
```

## Development workflow

- **Branch only for big work.** A new feature, a large refactor, a dependency upgrade, or broad
  risky work gets a `<type>/<topic>` branch off `main`. Bug fixes, small improvements and doc
  edits commit straight to `main`. Judge by scope and risk, not file count.
- **Commit in focused slices.** One commit per logical slice; keep lint green at each commit so
  branches stay bisectable. Conventional Commits. **No `Co-Authored-By` trailers and no
  AI-attribution lines anywhere** — commits or PR descriptions.
- **Explain the why in the commit body.** The subject says what changed; the body explains why —
  the problem and any non-obvious trade-off. Required for anything beyond trivial edits; `git log`
  should make sense without opening the PR.
- **Docs and tests ship *with* the change — not later.** The Docs section below says what each
  page tracks; update every page covering what you touched. `test/docs.test.ts` catches some
  drift mechanically, but it only checks what can be checked.
- **Verify before it lands** — the same list CI runs:
  `bun run lint && bun run typecheck && bun run test && bun run e2e`.
- **The two builds are slower; run them when they can actually fail.** CI builds the web app
  (`bun run --filter @tela/web build`, then `cd apps/web && bunx opennextjs-cloudflare build`) and
  the worker image (`apps/worker/Dockerfile`). Run them locally when you touch build config, the
  Next config, `wrangler.jsonc`, the Dockerfile, or a dependency — not for a change lint,
  typecheck and tests already cover.
- **Pushing and opening PRs are user-authorized** — don't push or open a PR unless asked.

## Hard invariants — do not break casually

1. **Runtime-agnostic packages.** No `Bun.*` APIs in `packages/*` or `apps/worker` source; the
   worker runs on Node 22 in production, with Bun only as the bundler (`apps/worker/Dockerfile`,
   ADR 0001).
2. **Cloudflare-specific code lives only in `apps/web/src/lib/platform/`.** Everything else in the
   web app must run unchanged on Vercel or a Node container (ADR 0002).
3. **Migrations via `drizzle-kit generate`, never `push`** — `push` has skipped policies in a
   known bug. Custom SQL (triggers, functions) goes in `--custom` files. RLS policies are declared
   in the schema with `pgPolicy` (ADR 0003).
4. **`NORM_VERSION` (`packages/shared`) must be bumped** whenever block normalization, placeholder
   grammar, or hashing rules in `packages/content` change. It is part of every block hash, so a
   silent change mixes old and new cache entries (ADR 0005).
5. **Model output is never trusted as HTML.** Translations are rehydrated by re-escaping text
   segments, and accepted only when their placeholder multiset matches the source. Validation
   stays in `translateBlocks` (ADR 0005).
6. **Jobs are idempotent.** Re-running any worker job must not duplicate rows or re-translate
   cached blocks (ADR 0004).
7. **Outbound fetches resolve their own hosts and refuse private ranges.** The worker DNS-pins via
   undici in Node; the relay serves only signed `POST /fetch`, refuses private ranges, does not
   follow redirects, and caps the upstream body. It is not an open proxy (ADR 0008).
8. **Reading languages are the launch set in `packages/shared/src/languages.ts`**; never translate
   into "every language a subscriber speaks" (ADR 0006).
9. **The web app never imports pg-boss.** Enqueue through `createJobSender` (`@tela/db/queue`),
   whose SQL mirrors pg-boss's insert plan; `packages/db/test/queue.test.ts` guards the coupling.
10. **Never interpolate numbers or identifiers into `` sql`` `` for DDL** without `sql.raw(...)`;
    drizzle turns interpolations into `$1` parameters (see the `recommendations_note_length`
    check).
11. **Raw SQL returns bigint columns as strings.** Convert ids with `Number()` in query helpers
    (see `listSubscriptions`), or use the typed query builder.
12. **Never name a package script `prepare`, `postinstall`, or another npm lifecycle hook** — Bun
    runs them on install.

## Toolchain notes

- Bun is the package manager, script runner, and test runner. Node 22 LTS is the production
  runtime for the worker (ADR 0001).
- Biome owns formatting and linting for everything; there is no second formatter.
- TypeScript strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. No enums: use `as const`
  unions. Single quotes, no semicolons, trailing commas.
- Test files are `*.test.ts` next to the code or under `test/`; Playwright specs are `*.e2e.ts`.
- `bun run db:local` gives you a migrated Postgres without Docker; with `TELA_DEV_AUTH=1` in
  `apps/web/.env` the app signs you in as the development user.
- **Use absolute paths in shell commands.** The shell's working directory persists between
  commands.

## Gotchas

Things that have already cost time here. Each one is a real defect, not a hypothetical.

- **`supabase config push` overwrites the Dashboard.** `supabase/config.toml` is the source of
  truth; a Dashboard toggle is a mirror the next push reverts. The Data API was switched off by
  hand and turned back *on* by the next push, because the file still said `enabled = true`
  (ADR 0014).
- **Supabase's stock auth templates carry only `{{ .ConfirmationURL }}`.** No code ever arrives,
  so a form that calls `verifyOtp` has nothing to verify — and that link returns to `site_url`
  with a PKCE code nothing exchanges. The templates live in `supabase/templates/` and are applied
  by config push; their link points at `/auth/callback` with a token hash the callback verifies
  directly, which works from any browser (a PKCE code needs the verifier cookie of the browser
  that asked) (ADR 0013).
- **A Next route file may only export handlers.** A helper exported alongside `GET` breaks the
  build; put it in its own module with its own test.
- **Create the abort signal once per request, not inside the redirect loop.** Otherwise every hop
  gets the full timeout again and politeness waits are never counted — a request configured for
  100 ms was observed taking ~500 ms through five redirects.
- **A job's execution budget must be shorter than its pg-boss lease.** A job that outlives its
  ten-minute lease runs concurrently with its own retry and pays the provider twice. Long work
  checkpoints per chunk and continues in a fresh job.
- **GLM copies straight quotes into JSON unescaped**, which invalidates the whole reply and makes
  the job retry into the same reply. `packages/llm` asks for escaped output and, when a reply
  still does not parse, recovers entries one at a time by id.
- **A queue's policy is fixed at creation.** If the code changes one, the worker refuses to start
  with "queue … has policy …; recreate it". Drain it, `select pgboss.delete_queue('<name>')`,
  restart.
- **A custom-domain route with no explicit `workers_dev` setting turns workers.dev off.** That is
  the intended end state here — workers.dev is blocked in mainland China — but it is a surprise if
  you were relying on that URL.
- **`LLM_PROVIDER` without a matching key falls back to the mock**, and the `translate` role
  refuses to start on that fallback: placeholder output would be cached for everyone. Set
  `LLM_PROVIDER=mock` deliberately for e2e and local runs.

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
- **Add a translation provider**: implement `Translator` (`packages/llm/src/types.ts`) or add a
  case to `createTranslator` in `packages/llm/src/providers.ts` using an AI SDK model, extend
  `configFromEnv`, and document the env vars in `docs/OPERATIONS.md`. Keep output validation in
  `translateBlocks`; never trust model output as HTML.

## Docs

Update whichever of these covers what you changed — in the same change:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the living system map: topology, monorepo layout,
  data model, content pipeline, ingestion, translation, queue, routes. Tracks: schema changes, new
  jobs, new routes, new safeguards.
- [docs/adr/](docs/adr/) — decision records 0001–0015. A reversed decision gets a superseding ADR,
  not a silent edit.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — provisioning and day-2 runbooks. Anything touching env
  vars, secrets, deploys, rate limits, or failure signatures lands here.
- [docs/DESIGN.md](docs/DESIGN.md) — tokens, layout rules, component inventory, the i18n string
  convention. Tracks: anything visual.
- [packages/content/README.md](packages/content/README.md) — the normative spec for sanitization,
  blocks, tagged text and hashing. Changing a rule here means bumping `NORM_VERSION`.
- `CHANGELOG.md` — release-worthy milestones under `[Unreleased]`; fine-grained history is the git
  log.
- `README.md` — layout and quick start for humans.
- `apps/web/AGENTS.md` — Next.js 16 rules that differ from older training data; read it before
  touching `apps/web`. It is generated by `next dev`, so don't hand-edit it.
