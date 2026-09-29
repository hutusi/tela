# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, …) working in this repository. This file is the single source of truth — CLAUDE.md imports it.

## Project

Tela is a multilingual reader and gathering place for independent blogs: readers subscribe to feeds, bloggers claim theirs and see who reads them, and LLM translation shows a post beside its original block by block. Bun workspaces and TypeScript throughout; three Cloudflare Workers (tela-web at the edge, tela-api and tela-jobs pinned beside a D1 primary in Singapore), R2 and Queues, a Vite + React reader that renders from the device, and one Node process (the China relay) that runs only if a feed ever needs it.

Decisions that look odd but are deliberate:

- **Tela is in private beta.** Registration is closed (better-auth's `disableSignUp`), the site is `noindex` while `TELA_PRIVATE_BETA` is set in `apps/reader/wrangler.jsonc`, and the way in is `bun run admin invite`. Invite codes were deliberately not built — their design should follow how we decide to open up (ADR 0015).
- **The reader never waits on the network.** Every screen renders from the rows the device holds in IndexedDB, and a seq-cursor sync keeps them current behind it; an RPC is only for an answer the member is waiting for (ADR 0025).
- **Reading languages are a fixed launch set**, never "every language a subscriber speaks": translation cost is bounded by the set, not by the audience (ADR 0006).
- **Titles translate eagerly, bodies lazily and streamed**, so a reader never pays for a post they do not open and sees the first paragraphs in seconds (ADRs 0006, 0023).
- **Portable by construction.** Only `packages/platform/src/cloudflare.ts` touches a binding; the suite runs everything on libSQL, memory blobs and an in-process queue, and the nightly export restores into any SQLite. Leaving Cloudflare is a weekend (ADR 0021).
- **Background work is state, not messages.** A domain row says what is due, a lease says who holds it, and a queue only speeds that up (ADR 0020).
- **The custom domain is the only public origin.** `workers.dev` is off on purpose: it is blocked in mainland China, so that URL is a dead link for part of the audience.

## Repo map

| Path | What |
| --- | --- |
| `apps/reader` | The reader, deployed as `tela-web`: one Vite project, one Worker. `src/` is the local-first SPA (ADR 0025): `store/` holds the device's rows in IndexedDB, syncs them and caches bodies; `views/` are the public pages, rendered by the SPA and by the edge (`src/ssr.tsx`); `lib/anchor.ts` and `lib/use-highlights.ts` are highlights (ADR 0026). `worker/edge.ts` is the one public Worker, at the edge and with no D1: `/api/*` to tela-api (writes must carry its origin), `/o/*` objects and `/o/bundle` from R2 through the colo cache, the `/img/<key>/<i>` proxy, and the public pages. `e2e/` runs all three Workers in one `wrangler dev` |
| `apps/api` | The `tela-api` Worker (ADR 0024): Hono, pinned beside D1, no public route. `src/app.ts` builds every route from portable deps (`createApp`), so the bun suite runs it on libSQL; `src/auth.ts` is better-auth (email codes, Drizzle adapter over `TelaDb`); `src/sync/` is the pull and the push; `src/worker.ts` is the Cloudflare entry; `scripts/admin.ts` is `bun run admin` (invite, curate) |
| `apps/jobs` | The `tela-jobs` Worker. `src/kinds.ts` is every kind of background work (due query, lease, backoff, queue, handler). `src/runner.ts` holds `tick` and `runJob`, both portable. `src/ops.ts` is the health check, the dead-man's ping and the weekly digest. `src/worker.ts` is the Cloudflare entry: its cron and queue handlers only dispatch to the Singapore-pinned fetch handler over `SELF`, which also exports the `Ingest` RPC. `src/portable.ts` runs the same work on a timer |
| `apps/relay` | The China fetch relay (ADR 0008) as its own Node app: `src/server.ts` over `node:http`, `src/safe-fetch.ts` (DNS-pinned undici), `src/config.ts`, and a Dockerfile. It is the only Node process Tela would run, and no box runs it until a feed times out from Cloudflare (OPERATIONS.md) |
| `packages/content` | **The content contract — keystone.** Sanitization, block normalization, tagged text, hashing, content objects. Its README is the normative spec behind `NORM_VERSION` |
| `packages/shared` | Constants shared everywhere: languages, topics, `NORM_VERSION`, limits, enums |
| `packages/platform` | The seams to whatever runs Tela: `Db` (Drizzle SQLite, batch-only), `Blobs`, `Jobs`, `Clock`, `Mail`. `./cloudflare` is the only module that touches a binding; `./portable` (libSQL held to D1's limits, S3, memory) is what tests and the exit path run (ADR 0021) |
| `packages/data` | The SQLite data model for D1 and libSQL: schema, migrations, the lease primitive, the sync sequence, query helpers, the nightly export (`src/backup.ts`), and the contract suite run on both engines |
| `packages/sync` | The sync protocol (ADR 0025): row shapes, the pull response, the zod schemas of the mutations a reader pushes, and the device's pure reducer (`applyPull`, `applyMutation`, `view`, `settle`). `apps/api/test/convergence.test.ts` holds the two to each other |
| `packages/ingest` | Fetching: the HTTP client, discovery, the ingest pipeline run under leases (`src/pipeline`), WebSub, the relay client, region policy. No runtime-specific APIs |
| `packages/llm` | Translation adapter, prompts, output validation |
| `packages/config` | Shared tsconfig bases |

## Commands

```sh
bun install                          # workspaces: apps/*, packages/*
bun run lint                         # Biome (format + lint); bun run lint:fix to auto-fix
bun run typecheck                    # tsc -p in every workspace (all noEmit)
bun run test                         # bun test: everything on libSQL, memory blobs and queues
bun run test:workers                 # on D1 in workerd: the data contract, and tela-api's sign-in, push and pull (Vitest + @cloudflare/vitest-pool-workers)
bun run e2e                          # Playwright: built tela-web + tela-api + tela-jobs in one wrangler dev, fixture feeds
bun run build                        # every workspace that has a build script
bun run dev                          # the reader in Vite, tela-api and tela-jobs beside it (http://localhost:5173; OPERATIONS.md)
bun run db:generate                  # drizzle-kit generate in packages/data; review the SQL, commit packages/data/migrations/*
bun run admin invite <email>         # invite a member through tela-api (ADMIN_TOKEN=…, TELA_URL optional)
bun run admin curate                 # add and feature the curated blogs (apps/api/scripts/curated-sites.ts)
cd apps/jobs && wrangler deploy      # deploy order: tela-jobs, tela-api, then tela-web
cd apps/reader && bunx vite build && wrangler deploy
```

## Development workflow

- **Branch only for big work** — a feature, a large refactor, a dependency upgrade — on a `<type>/<topic>` branch off `main`. Bug fixes, small improvements and doc edits commit straight to `main`. Judge by scope and risk, not file count.
- **Commit in focused slices**, keeping lint green at each so branches stay bisectable. Conventional Commits. **No `Co-Authored-By` trailers and no AI-attribution lines anywhere** — commits or PR descriptions.
- **Explain the why in the commit body.** The subject says what changed; the body says why, and names any non-obvious trade-off. `git log` should make sense without opening the PR.
- **Docs and tests ship *with* the change.** The Docs section below says what each page tracks; `test/docs.test.ts` catches the drift that can be caught mechanically, which is not most of it.
- **Verify gate**, the list CI runs: `bun run lint && bun run typecheck && bun run test && bun run test:workers && bun run e2e`. CI also bundles the three Workers and builds the relay image; run those when you touch build config, a `wrangler.jsonc`, the Dockerfile, or a dependency.
- **Pushing, opening PRs and deploying are user-authorized** — don't do any of them unless asked.

## Hard invariants — do not break casually

1. **Runtime-agnostic packages.** No `Bun.*` APIs in `packages/*` or app source: the Workers run on workerd and the relay on Node 24, with Bun only as the toolchain (ADR 0001).
2. **Only `packages/platform/src/cloudflare.ts` touches a Cloudflare binding.** Only the fetch handlers of the Singapore-pinned Workers query D1; cron and queue handlers dispatch to them over `SELF.fetch()` (ADR 0020).
3. **Batch-only SQL.** A `Db` has no `transaction()`, and the portable libSQL client throws if one is reached. Anything that must be atomic is a single statement or a `db.batch([...])`. D1 offers nothing else.
4. **Nothing exceeds D1's per-statement limits:** 100 bound parameters, 100 KB of SQL, five terms in a `UNION`/`INTERSECT`/`EXCEPT` chain (SQLite allows 500; a 40-row `union all` seed failed on D1 while libSQL took it). Bulk work passes one JSON parameter through `json_each(?1)`; a multi-row `VALUES` is not a compound and is fine. The portable client enforces all three, so the test that trips it is the one to fix, not the limit.
5. **Know what a write touched through `RETURNING`, never the run result.** D1 and libSQL report affected rows differently, so `Db`'s run result is `unknown` on purpose.
6. **Background work is state-driven and idempotent.** A domain row says what is due; `claimDue` takes it under a lease, and a queue only speeds that up. Any write decided in JavaScript commits as a fenced batch (`fence(...)` first, `release(...)` last), so a holder that lost its lease writes nothing. A re-run must not duplicate rows or re-translate cached blocks. Never add a job whose only record is a queue message.
7. **A batch that writes a synced row starts with `bumpSeq(db)` and stamps `seq: currentSeq`.** Otherwise readers never see the change.
8. **The UI reads only the local store.** A new view renders from `useTables()`; a change is a mutation (`packages/sync/src/mutations.ts`, applied on the server in `apps/api/src/sync/push.ts` and predicted in `packages/sync/src/client.ts`), guarded by its client id and resolved by the later `at`. A protocol change a cached shell cannot read bumps `MIN_CLIENT`.
9. **Migrations via `bun run db:generate`**, reviewed and committed, applied with `wrangler d1 migrations apply`. Never edit one that has been applied to production.
10. **Bump `NORM_VERSION`** whenever block normalization, placeholder grammar or hashing in `packages/content` changes. It is part of every block hash, so a silent change mixes old and new cache entries (ADR 0005).
11. **Model output is never trusted as HTML.** Text segments are re-escaped on rehydration, and a translation is accepted only when its placeholder multiset matches the source. Validation stays in `translateBlocks` (ADR 0005).
12. **Outbound fetches refuse private ranges.** The HTTP client checks names and literals, Cloudflare's `global_fetch_strictly_public` refuses the socket, and the relay pins the address it resolved. The relay serves only signed `POST /fetch`, follows no redirects and caps the body: it is not an open proxy (ADR 0008).
13. **Reading languages are the launch set in `packages/shared/src/languages.ts`** (ADR 0006).
14. **Never name a package script `prepare`, `postinstall`, or another npm lifecycle hook** — Bun runs them on install.

## Style

- TypeScript strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`. No enums: `as const` unions.
- Single quotes, no semicolons, trailing commas. Biome owns formatting and linting for everything; there is no second formatter.
- Tests are `*.test.ts` beside the code or under `test/`; Playwright specs are `*.e2e.ts`.
- **`@types/node` tracks the relay's runtime major** (Node 24, per `.node-version` and `engines`), not the newest release. Types ahead of the runtime typecheck APIs that are not there when it runs; `test/docs.test.ts` holds the two together.
- Use absolute paths in shell commands — the working directory persists between them.

## Gotchas

Defects that already cost time here, not hypotheticals.

- **A header breakpoint has a width budget, and `md` is where it runs out.** Turning the wordmark and a fixed 240px search field on together at 768px cost more than the viewport gained, so the nav — the one flex item with `min-w-0` — absorbed all of it and rendered 4px wide: no pointer route to Dashboard or Settings anywhere from 768px to about 1100px, and nobody noticed because the Playwright matrix ran 412 and 1280. Stage the controls across `lg` and `xl`, keep exactly one shrinkable item (the nav, which scrolls; everything else is `shrink-0` from `sm` up or it wraps its label into the 56px bar), and measure at the breakpoint itself — `styles.e2e.ts` does.
- **An unlayered rule in `styles.css` beats every Tailwind utility.** Tailwind v4 emits utilities into `@layer utilities`, and an unlayered declaration outranks every layered one whatever its specificity. An `a { }` block outside a layer made 30 `hover:no-underline` and every `text-ink` on a link dead code while the class strings still read correctly. Base element styles go in `@layer base`; `styles.e2e.ts` asserts the computed values, because nothing in the JSX shows this.
- **Two Tailwind utilities for the same property under different variants have no defined winner.** `data-[read=1]:opacity-[.62]` against `data-[active=1]:opacity-100` resolves by Tailwind's emission order, not by the order in the class string. Where one must beat the other, write both in `styles.css` and let source order say so.
- **A literal colour in a class list is a bug on the dark ground.** `bg-white` was on 31 elements, each of which stayed white in dark mode until it became `bg-surface`. Name a token; `styles.e2e.ts` checks both themes.
- **Two owners of one piece of state is the bug, not the symptom.** The URL alone says which article is open; anything else that claims to know (a cache, a closure) disagrees after Back restores an entry. The Postgres app settled that inline three reviews running (ADR 0017); the SPA has no second owner.
- **A handler reads the state it acts on when it runs, not when it was bound.** A second `j` can arrive before React has rendered the first one's navigation; the keyboard layer stepped from the wrong article until it read the URL at keypress time. Same for which article a close closed.
- **A fresh array every render is a loop once a layout effect sets state from it.** The untranslated-blocks list was rebuilt per render, harmless until the highlight hook (which runs after each body render) depended on it: React error #185, and every reading spec failed. Memoize what an effect depends on, and set state only when it changed.
- **Create the abort signal once per request, not inside the redirect loop**, or every hop gets the full timeout again: 100 ms was observed taking ~500 ms through five redirects.
- **A job's work must fit its lease.** A body translation holds its lease four minutes at a time, extending it in the batch that commits each chunk, and starts no chunk after ten minutes of the consumer's fifteen; the next execution continues from the cache. One that outlived its lease would run beside its own retry and pay the provider twice.
- **A lease attempt is counted when the work starts, not when it fails.** A Worker killed over its CPU or memory limit reports nothing, and its lease simply expires; counted at failure, that item was re-claimed every TTL for ever, and for a body translation every re-claim repeats a paid model call. `runJob` calls `startLease` before any work, and `tick` retires a re-claimed item that has spent its attempts instead of sending it.
- **GLM copies straight quotes into JSON unescaped**, invalidating the whole reply and making the job retry into the same reply; `packages/llm` recovers entries one at a time by id.
- **`LLM_PROVIDER` without a matching key falls back to the mock, and the translation kinds are then disabled** — placeholder output would be cached for everyone. Set `LLM_PROVIDER=mock` deliberately for e2e and local runs.
- **A title may legitimately translate to itself.** `validateTranslation` rejects an echo, so the title block opts out by id and the row is recorded as `echo`, not retried. Excerpts and bodies keep the check, and an echo is deliberately **not** written to the shared block cache: it is content-addressed and first-write-wins, so a body `<h1>` repeating the headline hashes identically and would inherit the judgement forever.
- **"Which title do I show?" and "do I badge it?" are different questions.** Answering both with one predicate has been written twice. Display uses the translation whenever one exists — search can match the translated title, so hiding it renders a hit with none of the words typed; the badge additionally needs the languages to differ. `shownTitle` in `apps/reader/src/store/selectors.ts`.
- **`zh-Hant` and `zh-Hans` are different languages here, and comparing language tags means comparing them exactly.** `normalizeLangTag` keeps those two variants and collapses every other tag to its primary subtag before storage, so a stored tag is never regional and a `split('-')` comparison buys nothing — it only merges the one pair the pipeline went out of its way to tell apart.
- **Never store a jittered value back into the field the jitter is computed from.** `fetch_interval_sec` fed its own ±10% back in as the next input, so the spread compounded per backoff step and the column climbed past the clamp. Jitter the derived timestamp, not the stored interval.
- **drizzle 0.45's D1 `batch` crashes on raw statements with parameters** ("cannot read properties of undefined (reading 'bind')"). It binds through a prepared `stmt` that `db.run(sql…)` items do not have, and every fenced or seq-stamped batch has such items. `d1Db` in `packages/platform/src/cloudflare.ts` rebuilds `batch` from each item's `getQuery()`. libSQL never had the bug, which is why the contract suite runs on D1 too (`bun run test:workers`); keep it green across drizzle upgrades.
- **Drizzle's table config names columns by their schema keys.** Under `casing: 'snake_case'`, `getTableConfig` reports `userId` for the column `user_id`; the export queried a column that does not exist until it converted with `toSnakeCase` for keys marked `keyAsName`.
- **SQLite's `INSERT … SELECT … ON CONFLICT` needs a `WHERE` on the SELECT**, or the upsert clause parses as a join constraint. `WHERE true` is enough; `claimDue` is the example.
- **A column named `end` (or another keyword) works only quoted in raw SQL.** `highlights.end` is `"end"` in every hand-written statement; the D1 run pushes a highlight to prove it.
- **better-auth's schema validation costs depend on the adapter.** Through its native D1 driver it introspects the database, about three round trips on every new instance (560–590 ms from the reader's edge, spike S4). Tela uses the Drizzle adapter, where it only inspects the schema object, so it stays on (ADR 0024). Behind Cloudflare it must key IPs on `cf-connecting-ip`, or every visitor shares one rate-limit bucket.
- **better-auth rate-limits its own endpoints per address**: three sign-in tries a minute. A test that makes a fourth try from one address is testing the rate limit, whatever it is named. Send each try from its own `cf-connecting-ip`, and test the limit on its own. The login page says "too many tries" for a 429, never "wrong code".
- **better-auth's `getCookieCache` picks the cookie's name from `NODE_ENV` unless told.** On an https origin the cookie is `__Secure-tela.session_data`. A check that leaves `isSecure` unset reads the other name, finds nothing, and falls back to a D1 read on every request, silently. tela-web passes `isSecure` from the request's protocol.
- **After calling another Worker, read the clock again before asking what is due.** The callee stamps rows with its own clock, which the call's own duration has moved past the caller's earlier `now`. tela-api claimed a new feed's first fetch with the `now` from before its `addFeed` RPC; the feed was due at tela-jobs' later time, so the claim found nothing and the reader waited for the next sweep.
- **Cron and queue handlers run far from D1** (Paris and Los Angeles in the spikes, 160–250 ms per round trip), and placement never moves them. Only a fetch handler pinned with `placement.region = aws:ap-southeast-1` sits beside the Singapore primary (6–10 ms). That is why every job body runs behind `SELF.fetch()`.
- **`wrangler dev --env-file` reaches only the primary Worker.** In a multi-config dev session, a secondary Worker reads its vars from its own config's directory. The e2e writes the three configs with the vars inlined instead (`apps/reader/e2e/stack.ts`).
- **The client imports constants from `@tela/shared`, not `@tela/sync`'s mutations module.** Importing anything from that module keeps its zod schemas in the SPA's bundle (339 KB of source); `@tela/sync` is marked side-effect free so an import of types alone drops it.
- **A device table the build adds makes older devices start over.** IndexedDB missing a table means a build that did not know it wrote the store, so the device takes a snapshot rather than trust a cursor that has passed rows it never kept (`apps/reader/src/store/db.ts`).

## How to

- **Add a table**: edit `packages/data/src/schema/`, `bun run db:generate`, review the SQL, and test what depends on the engine in `packages/data/src/contract.ts` (run on libSQL and D1). A synced table also needs `seq`, its pull query in `packages/data/src/queries/sync.ts`, its row type and reducer in `packages/sync`, and its name in the device's table list.
- **Add background work**: a kind in `apps/jobs/src/kinds.ts` (a due query over a domain row, lease TTL, backoff, queue, handler, what exhaustion writes); the logic in `packages/ingest/src/pipeline` or `apps/jobs/src`, tested with the portable runner and the fixture HTTP server. Name the kind in `docs/OPERATIONS.md`.
- **Add a mutation**: its schema in `packages/sync/src/mutations.ts`, its statements in `apps/api/src/sync/push.ts` (guarded by the mutation id, resolved by `at`), its prediction in `packages/sync/src/client.ts`, and a case in the convergence test.
- **Add a UI string**: `apps/reader/messages/en.json` and `zh-Hans.json`, same key in both.
- **Add a reading language**: `READING_LANGUAGES` and `LANGUAGE_NAMES` in `packages/shared`, plus a message catalog if it is also a UI locale.
- **Add a translation provider**: implement `Translator` (`packages/llm/src/types.ts`) or add a case to `createTranslator` (`packages/llm/src/providers.ts`), extend `configFromEnv`, and document the env vars in `docs/OPERATIONS.md`. Output validation stays in `translateBlocks`.

## Docs

Update whichever covers what you changed, in the same change:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the living system map. Tracks: schema changes, new kinds of work, new routes, new safeguards.
- [docs/adr/](docs/adr/) — decision records 0001–0027. A reversed decision gets a superseding ADR, not a silent edit.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — provisioning, deploys and day-2 runbooks. Anything touching env vars, secrets, deploys, rate limits or failure signatures lands here.
- [docs/DESIGN.md](docs/DESIGN.md) — tokens, layout rules, components, the i18n string convention.
- [packages/content/README.md](packages/content/README.md) — the normative spec for sanitization, blocks and hashing. Changing a rule here means bumping `NORM_VERSION`.
- `CHANGELOG.md` — release-worthy milestones under `[Unreleased]`; fine-grained history is the git log.
- `README.md` — layout and quick start for humans.
