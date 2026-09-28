# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, …) working in this repository. This file is the single source of truth — CLAUDE.md imports it.

## Project

Tela is a multilingual reader and gathering place for independent blogs: readers subscribe to feeds, bloggers claim theirs and see who reads them, and LLM translation shows a post beside its original block by block. Bun workspaces and TypeScript throughout; Next.js 16 on Cloudflare Workers, a Node 24 worker container, Supabase Postgres underneath.

Decisions that look odd but are deliberate:

- **Tela is in private beta.** Signup is closed in `supabase/config.toml`, and the site is `noindex` while `TELA_PRIVATE_BETA` is set in `apps/web/wrangler.jsonc`; the way in is an admin invite. Invite codes were deliberately not built — their design should follow how we decide to open up (ADR 0015).
- **Reading languages are a fixed launch set**, never "every language a subscriber speaks": translation cost is bounded by the set, not by the audience (ADR 0006).
- **Titles translate eagerly, bodies lazily**, so a reader never pays for a post they do not open (ADR 0006).
- **The web app must run unchanged off Cloudflare.** Bindings live only in `apps/web/src/lib/platform/` — which is what keeps the app testable without `wrangler` (ADR 0002).
- **The worker is one image, not six services.** `WORKER_ROLES` picks the queues a process subscribes to; `relay` serves only the signed fetch endpoint and never touches the database.
- **The custom domain is the only public origin.** `workers.dev` is off on purpose: it is blocked in mainland China, so that URL is a dead link for part of the audience.

## Repo map

| Path | What |
| --- | --- |
| `packages/content` | **The content contract — keystone.** Sanitization, block normalization, tagged text, hashing. Its README is the normative spec behind `NORM_VERSION` |
| `packages/shared` | Constants shared by web and worker: languages, topics, `NORM_VERSION`, enums |
| `packages/db` | Drizzle schema, migrations, query helpers, the job sender, the test harness |
| `packages/ingest` | Ingestion library: HTTP, discovery, fetch, extraction, region routing, WebSub. No queue, no runtime-specific APIs |
| `packages/llm` | Translation adapter, prompts, output validation |
| `packages/config` | Shared tsconfig bases |
| `packages/platform` | *(refactor/local-first)* The seams to whatever runs Tela: `Db` (Drizzle SQLite, batch-only), `Blobs`, `Jobs`, `Clock`, `Mail`. `./cloudflare` is the only module that touches a binding; `./portable` (libSQL held to D1's limits, S3, memory) is what tests and the exit path run (ADR 0021) |
| `packages/data` | *(refactor/local-first)* The SQLite data model for D1 and libSQL: schema, migrations, the lease primitive, the sync sequence, query helpers. Replaces `packages/db` at cutover |
| `apps/web` | Next.js 16 App Router, Tailwind v4, next-intl (no i18n routing), Drizzle server-side; Cloudflare Workers via OpenNext |
| `apps/worker` | Node 24 process bundled by Bun: `src/roles.ts`, `src/queues.ts`, `src/jobs/` |

## Commands

```sh
bun install                          # workspaces: apps/*, packages/*
bun run lint                         # Biome (format + lint); bun run lint:fix to auto-fix
bun run typecheck                    # tsc -p in every workspace (all noEmit)
bun run test                         # bun test; DB tests need initdb on PATH, PG_BIN_DIR, or TEST_DATABASE_URL
bun run test:workers                 # the D1 half of the data contract, in workerd (Vitest + @cloudflare/vitest-pool-workers)
bun run e2e                          # Playwright against a built app, worker, and fixture feeds
bun run build                        # every workspace that has a build script
bun run dev                          # web (http://localhost:3000)
bun run dev:worker                   # worker on Bun for dev; Node 24 in production
bun run db:generate                  # drizzle-kit generate; then commit packages/db/migrations/*
bun run db:migrate                   # apply migrations (DATABASE_URL=…)
bun run db:local --port 54322        # migrated Postgres with the development user, no Docker
bun run db:prepare                   # the same setup applied to an existing database
bun run worker:once fetch <feedUrl>  # run one job by hand (DATABASE_URL=…)
bun run worker:once repair-titles    # requeue missing eager title translations in batches
bun run worker:once seed-discover    # fetch the curated blogs and feature them in Discover
cd apps/web && bun run preview       # OpenNext build + local Workers runtime
cd apps/web && bun run icons         # redraw icon.svg, favicon.ico, apple-icon.png from the mark
```

## Development workflow

- **Branch only for big work** — a feature, a large refactor, a dependency upgrade — on a `<type>/<topic>` branch off `main`. Bug fixes, small improvements and doc edits commit straight to `main`. Judge by scope and risk, not file count.
- **Commit in focused slices**, keeping lint green at each so branches stay bisectable. Conventional Commits. **No `Co-Authored-By` trailers and no AI-attribution lines anywhere** — commits or PR descriptions.
- **Explain the why in the commit body.** The subject says what changed; the body says why, and names any non-obvious trade-off. `git log` should make sense without opening the PR.
- **Docs and tests ship *with* the change.** The Docs section below says what each page tracks; `test/docs.test.ts` catches the drift that can be caught mechanically, which is not most of it.
- **Verify gate**, the list CI runs: `bun run lint && bun run typecheck && bun run test && bun run test:workers && bun run e2e`. CI also builds the web app and the worker image; those are slow, so run them when you touch build config, `wrangler.jsonc`, the Dockerfile, or a dependency — not for a change the gate already covers.
- **Pushing and opening PRs are user-authorized** — don't do either unless asked.

## Hard invariants — do not break casually

1. **Runtime-agnostic packages.** No `Bun.*` APIs in `packages/*` or `apps/worker` source: the worker runs on Node 24 in production, with Bun only as the bundler (ADR 0001).
2. **Cloudflare-specific code lives only in `apps/web/src/lib/platform/`** (ADR 0002).
3. **Migrations via `drizzle-kit generate`, never `push`** — `push` has skipped policies in a known bug. Custom SQL goes in `--custom` files; RLS policies are declared in the schema with `pgPolicy` (ADR 0003).
4. **Bump `NORM_VERSION`** whenever block normalization, placeholder grammar or hashing in `packages/content` changes. It is part of every block hash, so a silent change mixes old and new cache entries (ADR 0005).
5. **Model output is never trusted as HTML.** Text segments are re-escaped on rehydration, and a translation is accepted only when its placeholder multiset matches the source. Validation stays in `translateBlocks` (ADR 0005).
6. **Jobs are idempotent** — a re-run must not duplicate rows or re-translate cached blocks (ADR 0004).
7. **Outbound fetches resolve their own hosts and refuse private ranges.** The relay serves only signed `POST /fetch`, follows no redirects and caps the body: it is not an open proxy (ADR 0008).
8. **Reading languages are the launch set in `packages/shared/src/languages.ts`** (ADR 0006).
9. **The web app never imports pg-boss.** Enqueue through `createJobSender` (`@tela/db/queue`), whose SQL mirrors pg-boss's insert plan; `packages/db/test/queue.test.ts` guards the coupling.
10. **Never interpolate numbers or identifiers into `` sql`` `` for DDL** without `sql.raw(...)` — drizzle turns interpolations into `$1` parameters.
11. **Raw SQL returns bigint columns as strings.** Convert ids with `Number()` in query helpers, or use the typed query builder.
12. **Never name a package script `prepare`, `postinstall`, or another npm lifecycle hook** — Bun runs them on install.

### The local-first stack (`refactor/local-first`: `packages/platform`, `packages/data`, and what builds on them)

These govern the new packages now. They become the whole list at cutover, when the Postgres-era invariants above go with the code they protect (ADRs 0020, 0021).

13. **Batch-only SQL.** A `Db` has no `transaction()`, and the portable libSQL client throws if one is reached. Anything that must be atomic is a single statement or a `db.batch([...])`. D1 offers nothing else.
14. **Nothing exceeds D1's per-statement limits:** 100 bound parameters, 100 KB of SQL. Bulk work passes one JSON parameter through `json_each(?1)`. The portable client enforces this, so the test that trips it is the one to fix, not the limit.
15. **Know what a write touched through `RETURNING`, never the run result.** D1 and libSQL report affected rows differently, so `Db`'s run result is `unknown` on purpose.
16. **Background work is state-driven.** A domain row says what is due; `claimDue` takes it under a lease, and a queue only speeds that up. Any write decided in JavaScript commits as a fenced batch (`fence(...)` first, `release(...)` last), so a holder that lost its lease writes nothing. Never add a job whose only record is a queue message.
17. **A batch that writes a synced row starts with `bumpSeq(db)` and stamps `seq: currentSeq`.** Otherwise readers never see the change.
18. **Only `packages/platform/src/cloudflare.ts` touches a Cloudflare binding.** Only the fetch handlers of the Singapore-pinned Workers query D1; cron and queue handlers dispatch to them over `SELF.fetch()` (ADR 0020).

## Style

- TypeScript strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. No enums: `as const` unions.
- Single quotes, no semicolons, trailing commas. Biome owns formatting and linting for everything; there is no second formatter.
- Tests are `*.test.ts` beside the code or under `test/`; Playwright specs are `*.e2e.ts`.
- **`@types/node` tracks the worker's runtime major** (Node 24, per `.node-version` and `engines`), not the newest release. Types ahead of the runtime typecheck APIs that are not there when it runs; `test/docs.test.ts` holds the two together.
- Use absolute paths in shell commands — the working directory persists between them.

## Gotchas

Defects that already cost time here, not hypotheticals.

- **`supabase config push` overwrites the Dashboard.** `config.toml` is the source of truth; a Dashboard toggle is a mirror the next push reverts. This is how the Data API got switched back on (ADR 0014).
- **`[auth.email] enable_signup` is the email *provider* switch, not a signup switch.** The CLI maps it to GoTrue's `EXTERNAL_EMAIL_ENABLED`, so `false` disables email sign-in for everyone — existing accounts included — and every member is locked out while the login page still looks healthy. Registration is closed by `enable_signup = false` under `[auth]` alone. `GET /auth/v1/settings` with the anon key reports the truth: `external.email` and `disable_signup` (ADR 0015).
- **Branch a Supabase auth failure on `error.code`, never the HTTP status.** GoTrue answers 422 for a missing account (`otp_disabled`), a disabled provider (`email_provider_disabled`) and a rejected address alike; mapping the status told members with working accounts that they had never registered (`apps/web/src/lib/login-error.ts`).
- **Supabase's stock auth templates carry only `{{ .ConfirmationURL }}`** — no code for a form that calls `verifyOtp`, and a link that lands on the site root with nothing to make a session from. Ours live in `supabase/templates/` (ADR 0013).
- **`revalidatePath` in a server action re-renders the page inside the action's own response**, and a `router.refresh()` in the caller renders it again. On `/reading` that was two full renders of a three-pane page for a value the caller already held. Revalidate only when server state changed and the caller has no optimistic path; never pair it with a refresh (ADR 0016).
- **`router.refresh()` on a timer re-renders the whole page.** Waiting on background work polls `/api/reading/state` for one row and re-fetches only the article pane from `/api/reading/article` when something actually changed (ADR 0017).
- **Two owners of one piece of state is the bug, not the symptom.** On `/reading` the URL and Next's cached server state both claim to know which article is open, and they disagree after a `pushState` entry is restored. Settling that inline, per trigger, was wrong three reviews running; the rule now lives in `apps/web/src/lib/reader-navigation.ts` where it can be read and tested (ADR 0017).
- **A header breakpoint has a width budget, and `md` is where it runs out.** Turning the wordmark and a fixed 240px search field on together at 768px cost more than the viewport gained, so the nav — the one flex item with `min-w-0` — absorbed all of it and rendered 4px wide: no pointer route to Dashboard or Settings anywhere from 768px to about 1100px, and nobody noticed because the Playwright matrix ran 412 and 1280. Stage the controls across `lg` and `xl`, keep exactly one shrinkable item (the nav, which scrolls; everything else is `shrink-0` from `sm` up or it wraps its label into the 56px bar), and measure at the breakpoint itself — `styles.e2e.ts` does.
- **An unlayered rule in `globals.css` beats every Tailwind utility.** Tailwind v4 emits utilities into `@layer utilities`, and an unlayered declaration outranks every layered one whatever its specificity. The `a { }` block sat outside a layer: 30 `hover:no-underline` and every `text-ink` on a link were dead code while the class strings still read correctly, so the whole chrome rendered accent green and underlined on hover. Base element styles go in `@layer base`; `styles.e2e.ts` asserts the computed values, because nothing in the JSX shows this.
- **Two Tailwind utilities for the same property under different variants have no defined winner.** `data-[read=1]:opacity-[.62]` against `data-[active=1]:opacity-100` resolves by Tailwind's emission order, not by the order in the class string. Where one must beat the other, write both in `globals.css` and let source order say so.
- **A Next route file may only export handlers** — a helper exported beside `GET` breaks the build. Give it its own module and its own test.
- **Create the abort signal once per request, not inside the redirect loop**, or every hop gets the full timeout again: 100 ms was observed taking ~500 ms through five redirects.
- **`apps/web/.env` and `bun run deploy` do not mix.** `next build` inlines what it finds in
  `.env*`, and `getDb` prefers an explicit `DATABASE_URL` over the HYPERDRIVE binding, so a deploy
  from a checkout you also develop in bakes a localhost database into the Worker and every request
  fails. `.env` is gitignored, so nothing in git says a word — and `.env.example` ships that
  localhost URL for the documented local setup. `apps/web/scripts/preflight-deploy.ts` refuses the
  deploy now; it took the site down once first.
- **Two fetches of one feed can run at once**, and every part of storing a fetch has to survive
  it. pg-boss's `short` policy dedups `created` jobs only, so a retry runs beside its own active
  job; a hand-run command races the scheduler the same way. Three things follow, and the first two
  were each written without the third. The insert is `onConflictDoNothing` on
  `(feed_id, dedup_key)`, so the loser does not throw away the whole fetch. The loser then
  *re-reads the row and compares content* rather than reporting it unchanged, or it drops its own
  version of the item whenever the two fetches read different bodies. And `last_body_hash` is
  claimed only while `last_fetched_at` still holds the value the fetch started with — it is a
  promise that the stored articles match that body, and the next fetch skips everything when it
  matches, so a hash recorded beside another fetch's article writes strands the stale copy until
  the feed changes again. The loser of that check clears the hash instead, which makes the next
  fetch reprocess and repair whatever the interleaving left.

  **Known residual, deliberately not patched further.** The claim keys on `last_fetched_at`, which
  only moves when the other fetch finishes. A fetch that commits some article updates and *then
  throws* mid-loop leaves that column untouched, so a concurrent fetch still claims its hash over
  the older content. It needs all three of: a second fetch of the same feed, a different body, and
  a mid-loop failure — and it repairs itself the next time the feed changes. Three rounds of
  making individual writes defensive each closed one seam and revealed the next; the fix is to
  stop two fetches of one feed running at once, which is what pg-boss's singleton is supposed to
  provide and does not (its unique index covers `created` only). Serialize per feed rather than
  adding a fourth guard here.
- **A job's execution budget must be shorter than its pg-boss lease**, or a job outlives the lease, runs concurrently with its own retry, and pays the provider twice.
- **GLM copies straight quotes into JSON unescaped**, invalidating the whole reply and making the job retry into the same reply; `packages/llm` recovers entries one at a time by id.
- **A queue's policy is fixed at creation.** Change one in code and the worker refuses to start: drain it, `select pgboss.delete_queue('<name>')`, restart.
- **`LLM_PROVIDER` without a matching key falls back to the mock, and the `translate` role refuses to start on that fallback** — placeholder output would be cached for everyone. Set `LLM_PROVIDER=mock` deliberately for e2e and local runs.
- **`onArticleStored` is the only thing that queues title translations.** `fetchFeed` stores articles; the caller supplies `titleEnqueuer`. A caller that forgets it ingests articles nothing will ever translate, and nothing retries — that is how 46 live articles ended up with no title job. Any new `fetchFeed` caller passes it.
- **A title may legitimately translate to itself.** `validateTranslation` rejects an echo, so the title block opts out by id. Excerpts and bodies keep the check, and an echo accepted by that exemption is deliberately **not** written to the shared block cache: it is content-addressed and first-write-wins, so a body `<h1>` repeating the headline hashes identically and would inherit the judgement forever. Note the failure shape this caused: `translateArticleTitle` returning `failed` only warns, and the pg-boss job *completes* — no row, no dead letter, nothing to query.
- **pg-boss's `short` policy dedups `created` jobs only.** Its unique index is `where state = 'created'`, so a singleton key does not stop a second job while the first is `active` or `retry`. Anything that re-queues work already in flight — recovery commands especially — must check `pgboss.job` itself, not rely on the key.
- **"Which title do I show?" and "do I badge it?" are different questions.** Answering both with one predicate has been written twice. Display uses the translation whenever one exists — search matches `translated_title` in SQL, so hiding it renders a hit with none of the words typed; the badge additionally needs the languages to differ. `apps/web/src/components/shows-translation.ts`.
- **`zh-Hant` and `zh-Hans` are different languages here, and comparing language tags means comparing them exactly.** `normalizeLangTag` keeps those two variants and collapses every other tag to its primary subtag before storage, so a stored tag is never regional and a `split('-')` comparison buys nothing — it only merges the one pair the pipeline went out of its way to tell apart. The worker translates between them, the block cache namespaces them separately, `languageBadge` renders `ZH-TW` against `ZH`, and discover lists them as two languages.
- **Never store a jittered value back into the field the jitter is computed from.** `fetch_interval_sec` fed its own ±10% back in as the next input, so the spread compounded per backoff step and the column climbed past the clamp. Jitter the derived timestamp, not the stored interval.
- **drizzle 0.45's D1 `batch` crashes on raw statements with parameters** ("cannot read properties of undefined (reading 'bind')"). It binds through a prepared `stmt` that `db.run(sql…)` items do not have, and every fenced or seq-stamped batch has such items. `d1Db` in `packages/platform/src/cloudflare.ts` rebuilds `batch` from each item's `getQuery()`. libSQL never had the bug, which is why the contract suite runs on D1 too (`bun run test:workers`); keep it green across drizzle upgrades.
- **SQLite's `INSERT … SELECT … ON CONFLICT` needs a `WHERE` on the SELECT**, or the upsert clause parses as a join constraint. `WHERE true` is enough; `claimDue` is the example.
- **better-auth validates its schema at runtime by default**, which costs about three D1 round trips on every new instance (560–590 ms from the reader's edge, spike S4). Production sets `advanced.database.validateSchema: false` and CI runs the check. Behind Cloudflare it must also key IPs on `cf-connecting-ip`, or every visitor shares one rate-limit bucket.
- **Cron and queue handlers run far from D1** (Paris and Los Angeles in the spikes, 160–250 ms per round trip), and placement never moves them. Only a fetch handler pinned with `placement.region = aws:ap-southeast-1` sits beside the Singapore primary (6–10 ms). That is why every job body runs behind `SELF.fetch()`.

## How to

- **Add a table**: edit `packages/db/src/schema/`, adding `pgPolicy` rows and `.enableRLS()` if there is no policy; `bun run db:generate`; review the SQL; add a test in `packages/db/test/`.
- **Add a worker job**: logic in `packages/ingest` (pure library, tested with the fixture HTTP server and the DB harness), queue and payload type in `apps/worker/src/queues.ts`, a thin handler under `apps/worker/src/jobs/`, subscribed under the right role in `apps/worker/src/index.ts`.
- **Add a UI string**: `apps/web/messages/en.json` and `zh-Hans.json`, same key in both.
- **Add a reading language**: `READING_LANGUAGES` and `LANGUAGE_NAMES` in `packages/shared`, plus a message catalog if it is also a UI locale.
- **Add a translation provider**: implement `Translator` (`packages/llm/src/types.ts`) or add a case to `createTranslator` (`packages/llm/src/providers.ts`), extend `configFromEnv`, and document the env vars in `docs/OPERATIONS.md`. Output validation stays in `translateBlocks`.

## Docs

Update whichever covers what you changed, in the same change:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the living system map. Tracks: schema changes, new jobs, new routes, new safeguards.
- [docs/adr/](docs/adr/) — decision records 0001–0021. A reversed decision gets a superseding ADR, not a silent edit.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — provisioning and day-2 runbooks. Anything touching env vars, secrets, deploys, rate limits or failure signatures lands here.
- [docs/DESIGN.md](docs/DESIGN.md) — tokens, layout rules, components, the i18n string convention.
- [packages/content/README.md](packages/content/README.md) — the normative spec for sanitization, blocks and hashing. Changing a rule here means bumping `NORM_VERSION`.
- `CHANGELOG.md` — release-worthy milestones under `[Unreleased]`; fine-grained history is the git log.
- `README.md` — layout and quick start for humans.
- `apps/web/AGENTS.md` — Next.js 16 rules that differ from older training data. Generated by `next dev`, so don't hand-edit it.
