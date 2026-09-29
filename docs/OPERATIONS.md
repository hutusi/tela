# Operations

How Tela is provisioned and deployed. Everything below is live unless marked *later*; the
"Later" section at the end is the open list.

## Environments

| Component | Where | Notes |
|---|---|---|
| Web | Cloudflare Workers via OpenNext (`apps/web`) | Custom domain only; never share `workers.dev` URLs (blocked in mainland China) |
| Database + Auth | Supabase, region Tokyo (`ap-northeast-1`) | session pooler as the connection path (the IPv4 add-on is optional, see Provisioning); custom SMTP (Resend); custom auth domain *later* |
| Worker | Fly.io app `tela-worker`, region `nrt` (`apps/worker`) | Docker image, Node 24; roles via `WORKER_ROLES` |
| Relay | *Not provisioned*: an HK or CN box running `WORKER_ROLES=relay` when a feed needs it | Signed fetch endpoint only, no `DATABASE_URL`; runbook below. Every production feed fetches directly, so none runs (2026-09-28) |
| Assets | Cloudflare R2 bucket behind `assets.<domain>` | favicons and covers |

## Environment variables

| Name | Used by | Meaning |
|---|---|---|
| `DATABASE_URL` | worker, web (local / non-Cloudflare) | Postgres connection string. On Cloudflare the `HYPERDRIVE` binding replaces it. |
| `WORKER_ROLES` | worker | Comma list of roles; default is every role except `relay` |
| `LOG_LEVEL` | worker | `debug` / `info` / `warn` / `error` |
| `HEARTBEAT_SEC` | worker | Seconds between pg-boss job heartbeats (default 60) |
| `LLM_PROVIDER` | worker | `bailian` (default), `anthropic`, or `mock`; any other value is an error. Without the matching key the mock is used, but the `translate` role refuses to start on that fallback: its placeholder output would be cached for everyone. Set `LLM_PROVIDER=mock` to run the mock on purpose (e2e, local) |
| `LLM_MODEL` | worker | Model id: `glm-5.2` (Bailian default), `claude-opus-5` (Anthropic default) |
| `BAILIAN_API_KEY`, `BAILIAN_BASE_URL` | worker | Aliyun Bailian key; base URL defaults to `https://dashscope.aliyuncs.com/compatible-mode/v1` (use the workspace/region host from the console when required) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | worker | Anthropic key; base URL optional |
| `LLM_JSON_MODE` | worker | `text` (parse JSON from the reply; default for Bailian) or `schema` (structured output; default for Anthropic) |
| `LLM_DAILY_BUDGET_TOKENS` | worker | Daily cap for background (title) translation; `0` = unlimited; `fly.worker.toml` sets 2,000,000. Reader requests always run and are rate-limited per member instead |
| `LLM_MAX_ARTICLE_TOKENS` | worker | Source tokens translated per article body (default 40,000, about 14 model calls); the rest stays as source and the translation is `partial` |
| `LLM_MOCK_DROP_MARKER` | worker | Tests only, and only with `LLM_PROVIDER=mock`: the mock leaves out every block whose source text contains this string, so a run can reach a `partial` body. Ignored by a mock that was fallen back to rather than asked for |
| `PUBLIC_URL` | worker | Public origin of the web app, for verifying rel="me" claim links |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | worker | Favicon/cover uploads to R2; `ASSETS_DIR` writes to a directory instead (dev); neither disables uploads |
| `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_ASSETS_URL` | web | Public origin (claim snippets) and the assets bucket's public base URL |
| `RELAY_URL`, `RELAY_SECRET` | worker (fetch/claim/assets roles) | Origin of the relay role and the shared signing secret; unset `RELAY_URL` = no relay, feeds never change region |
| `RELAY_SECRET`, `RELAY_SECRET_PREVIOUS`, `RELAY_PORT` | worker (`relay` role) | Accepted signing secrets (previous one during rotation) and the listen port (8787) |
| `WEBSUB_ENABLED` | worker | `1` subscribes at feeds' WebSub hubs (needs `PUBLIC_URL` reachable from the internet); default `0` |
| `RELAY_CONTROL_URL` | worker | Fetched before flipping a feed to the relay; if it fails too, the worker's own network is the problem (default: Cloudflare's trace endpoint) |
| `WORKER_USER_AGENT` | worker | Sent on every fetch; keep a contact URL in it |
| `FETCH_TIMEOUT_MS`, `FETCH_CONCURRENCY`, `SCHEDULER_BATCH` | worker | Per-request timeout (20 s), parallel fetches per process (4), max feeds enqueued per tick (500) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | Supabase Auth (cookies via `@supabase/ssr`) |
| `IMAGE_PROXY_SECRET` | web | HMAC key for `/img` URLs; set as a Worker secret (`wrangler secret put`) |
| `TELA_DEV_AUTH` | web (local only) | `1` signs every request in as the development user; refused on Cloudflare |
| `TELA_DEV_USER_ID` | web (local only) | Overrides which user dev-auth signs in as; defaults to the development user `bun run db:local` creates |
| `TELA_ALLOW_PRIVATE_HOSTS`, `WORKER_ALLOW_PRIVATE_HOSTS` | tests only | let discovery/fetch reach localhost fixture servers. In production the worker resolves every outbound host itself and refuses names that resolve to a private address (DNS-pinned via undici); the pinning is Node-only, so `bun run dev:worker` keeps just the name and literal checks. `apps/worker/scripts/safe-fetch-check.ts` verifies the Node path |
| `NEXTJS_ENV` | web (`.dev.vars`) | Which `.env` files OpenNext loads locally |
| `TEST_DATABASE_URL`, `PG_BIN_DIR` | tests | Use an existing database, or point at Postgres binaries |

## Provisioning

### Supabase
1. Create a project in Tokyo. Use the *session* pooler connection string
   (`postgres.<ref>@aws-0-<region>.pooler.supabase.com:5432`) for Hyperdrive, the worker, and
   migrations: it has IPv4 and session mode keeps prepared statements. The direct host is
   IPv6-only, and the paid IPv4 add-on (Project Settings → Add-ons) is optional: turn it on only if
   the pooler's session-mode pool runs out (`/api/health` or the worker's health check report
   pooler connection errors) and raising the pool size under Database → Connection pooling is not
   enough. Decided 2026-09-05 to keep it off.
2. Email through Resend (built-in SMTP is capped at 2 emails/hour): verify the sending domain in
   Resend (its DKIM, SPF and MX records go into the Cloudflare zone), create a sending-only API
   key, put it in `.env.supabase` as `SUPABASE_AUTH_SMTP_PASS`, and `supabase config push` applies
   the `[auth.email.smtp]` block and the raised `email_sent` rate limit. The same push applies the
   email templates in `supabase/templates`: they carry the one-time code the login form asks for
   and a link to `/auth/callback` with a token hash (works from any browser); Supabase's stock
   templates carry neither, only a link that lands on the site root. Verify delivery to qq.com
   and 163.com addresses.
3. Auth → Providers: Email (OTP), GitHub, Google (phase 4).

   **Private testing.** `enable_signup = false` under both `[auth]` and `[auth.email]`: nobody can
   create an account from the login page, which answers "Tela is in private testing" instead. Add
   a tester with an admin invite — Dashboard → Authentication → Users → **Invite user**, or
   `auth.admin.inviteUserByEmail` with the service-role key — which sends the invite template in
   `supabase/templates/invite.html`; its link signs them in through `/auth/callback`. Like the
   Data API, this is pushed from `config.toml`, so a Dashboard change would be overwritten by the
   next `supabase config push`. The web app is also hidden from search engines while
   `TELA_PRIVATE_BETA` is set in `apps/web/wrangler.jsonc` (robots.txt disallow plus a noindex
   tag). Opening up = `enable_signup = true` + push, and removing that var + deploy.
4. Apply migrations: `DATABASE_URL=<session pooler connection> bun run db:migrate`.
5. The Data API is off: `[api] enabled = false` in `supabase/config.toml`, applied by
   `supabase config push`. The Dashboard toggle (Data API integration overview → **Enable Data
   API**) does the same thing, but the next `config push` re-applies whatever the file says (seen
   on 2026-09-05), so the file is the source of truth. `public` is always among the exposed
   schemas while the API is on, and the GraphQL endpoint reflects it as well. The app never uses
   the Data API (all queries go through Postgres directly, supabase-js is auth only), and the
   read-only RLS policies remain the backstop for as long as it is on. Turn it back on only if a
   browser feature (Realtime) ever needs it.

### Cloudflare
```sh
cd apps/web
bunx wrangler login       # from a real terminal; the browser flow needs a TTY
bunx wrangler hyperdrive create tela-db --connection-string="<supabase connection string>"
# paste the returned id into wrangler.jsonc → hyperdrive[0].id (ids are not secrets)
bunx wrangler secret put IMAGE_PROXY_SECRET
bun run deploy            # opennextjs-cloudflare build && deploy
```
- `NEXT_PUBLIC_*` values are inlined at build time: put them in `apps/web/.env.production`
  (gitignored) so `bun run deploy` and CI builds see them: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_ASSETS_URL`.
- Hyperdrive needs an IPv4 origin: point it at the *session* pooler (Supabase step 1). Cloudflare
  recommends Supabase's direct connection, which needs the paid IPv4 add-on; if that add-on is
  ever turned on, recreate Hyperdrive with the direct connection string. Hyperdrive's own
  endpoint is plain TCP: the client must not ask for TLS there (`sslModeFor` in `@tela/db`
  handles `*.hyperdrive.local`).
- The first request after a deploy can wait up to the driver's 30 s connect timeout while
  Hyperdrive opens its origin connection; `/api/health` reports `databaseMs` and the error text.
- Then add the custom domain under Workers & Pages → tela-web → Settings → Domains, and in the
  same change:
  - `supabase/config.toml`: set `[auth] site_url` to the new origin and add `https://<domain>/**`
    to `additional_redirect_urls`, then `supabase config push`. OAuth builds its callback from the
    request host, so a domain missing from that list makes GitHub/Google sign-in fail with a
    redirect error; magic-link emails use `site_url`, so they would keep pointing at the old
    origin (blocked in mainland China) until this is done.
  - `NEXT_PUBLIC_SITE_URL` (web) and `PUBLIC_URL` (worker) to the new origin: claim snippets and
    `rel="me"` verification compare against them.
- The production build runs `next build --webpack` (`apps/web/package.json`): Turbopack in Next
  16.3 panics while chunking any middleware file in this app (`ModuleGraph::from_graphs_inner was
  canceled`), and the session-refresh middleware is not optional. `next dev` still uses Turbopack.
  Retry the default bundler after the next Next.js upgrade.

R2 for favicons and covers: `bunx wrangler r2 bucket create tela-assets --location apac`, then
either connect a custom domain (`assets.<domain>`) under the bucket's settings or, before a
domain exists, `bunx wrangler r2 bucket dev-url enable tela-assets` (rate-limited, fine for
previews). Create an R2 API token with object read/write in the dashboard (R2 → Manage API
tokens; wrangler cannot), set the `R2_*` variables on the worker, and
`NEXT_PUBLIC_ASSETS_URL` on the web app.

### Curation
Discover has three doors (ADR 0018): the editorial seed below, a verified claim, and three
distinct subscribers on an unclaimed site.

- **Apply the editorial list**: `DATABASE_URL=… bun run worker:once seed-discover`, which fetches
  every blog in `apps/worker/src/seed/curated-sites.ts` and features its site with the list's
  topics. Flags: `--dry-run` (resolve and report, no network and no writes), `--limit N` and
  `--skip N` (a window into the list, for staging a large seed across runs), `--only <match>`
  (substring of the feed URL, for retrying one failure). Re-running is the normal case: a second
  run answers 304, stores nothing, and skips a write that would change nothing. Exit 1 means at
  least one entry errored; the report still prints.
- **Stage with `--skip`, not by widening `--limit`.** Widening alone re-fetches every earlier
  entry, and a blog that counts requests per hour rather than bytes reads three conditional GETs
  in fifteen minutes as a misbehaving reader — rachelbythebay.com, which runs a feed-reader
  conformance test, refused the connection outright after exactly that. `--limit 5`, then
  `--skip 5 --limit 10`, then `--skip 15` covers each blog once.
- **Start the worker first.** pg-boss creates `translate.title` on start, and a seed run against a
  database it has never touched warns `titleQueue: missing` and seeds articles with no title
  translations. The recovery is `bun run worker:once repair-titles`, which is also how to pick up
  the tail of a long archive: a fetch stores up to `MAX_ITEMS_PER_FETCH` (200) articles but queues
  at most `TITLE_JOBS_PER_FETCH` (100) titles.
- **Cost**: two reading languages, so at most one title job per article per language and at most
  100 per feed — roughly 3,500 for a 35-blog seed. Bodies stay lazy, so the seed costs nothing
  until somebody opens a post. Batch it with `--limit` and watch `LLM_DAILY_BUDGET_TOKENS`.
- **Failure signatures** in a run's report: `too_large` — the feed is over the worker's 5 MB body
  cap, so use the blog's recent-items feed instead of its full archive; `timeout` on a mainland
  host — the CLI passes no region policy and never flips a feed itself, so add `region: 'cn'` to
  that entry; `no_articles` — the feed parsed but held nothing, so the site is left unlisted;
  `duplicate` — the curated URL permanently redirects onto a feed already stored, so the run
  adopts that one and reports its id. Harmless but not free: point the list entry at the URL the
  blog actually serves and the redirect stops being paid for on every run. The entry is always
  curated against the feed it duplicates, never the alias — an alias on another host sits on a
  placeholder site of its own, and featuring that would publish the blog under a site nobody
  owns. With `orphaned: true` the alias row was left in place because a member subscribes to it
  or it already holds articles they may have read, liked or recommended; decide that by hand
  rather than letting a seed run delete it: `select * from feeds where id = …`, then `delete
  from feeds where id = …` once you are satisfied nobody is reading it.
- Feature a site by hand: `update sites set listing = 'featured' where id = …`; hide one:
  `'rejected'`, which the seed then leaves alone on every later run.
- Release a claim so another member can claim the site: `update sites set claimed_by = null,
  claimed_at = null where id = …; delete from site_claims where site_id = …`.

### Fly.io (worker)
```sh
fly auth login            # from a real terminal
fly apps create tela-worker --org <org>
fly secrets set --app tela-worker --stage DATABASE_URL="<supabase connection string>" \
  PUBLIC_URL="https://<web origin>" BAILIAN_API_KEY="…" R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… \
  R2_SECRET_ACCESS_KEY=… R2_BUCKET=tela-assets
fly deploy --config fly.worker.toml --remote-only --ha=false   # from the repository root
```
- `fly.worker.toml` sits at the repository root because Fly's build context is the config's
  directory and the image builds from the whole monorepo (`.dockerignore` keeps it small).
- Override roles per deploy with `-e WORKER_ROLES=scheduler,fetch,extract,claim,assets`, for
  example to run without `translate` until the LLM key exists. With the key missing the worker
  refuses to start the `translate` role at all (rather than caching the mock's placeholder
  translations), so a forgotten secret shows up as a crash loop, not as garbled titles.
- Logs: `fly logs --app tela-worker`; the JSON lines are the same as locally.

### Running the new stack locally (`refactor/local-first`)

`bun run dev:reader` is Vite with the Cloudflare plugin: the SPA with hot reload, tela-web's
Worker, and tela-api and tela-jobs beside it as auxiliary Workers, all in workerd. Service
bindings, the `Ingest` RPC, local queues, D1 and R2 all work, and the three share one local D1 and
bucket because their configs name the same ones.

```sh
S=$(openssl rand -hex 32)
printf "AUTH_SECRET=$S\nADMIN_TOKEN=local\nENV=test\nPUBLIC_URL=http://localhost:5173\n" > apps/api/.dev.vars
printf "ENV=test\nLLM_PROVIDER=mock\nPUBLIC_URL=http://localhost:5173\n" > apps/jobs/.dev.vars
printf "AUTH_SECRET=$S\nTELA_PRIVATE_BETA=1\n" > apps/reader/.dev.vars
apps/reader/node_modules/.bin/wrangler d1 migrations apply tela --local \
  --persist-to apps/reader/.wrangler/state -c apps/api/wrangler.jsonc
bun run dev:reader   # http://localhost:5173
```

Then:
1. Invite: `TELA_URL=http://localhost:5173 ADMIN_TOKEN=local bun run admin invite you@x.test`.
2. Sign in at `/login`, reading the code from `/api/test/outbox?email=you@x.test`.
3. Add a feed on `/add`. The crons do not fire in dev: `curl -X POST -H 'origin:
   http://localhost:5173' localhost:5173/api/test/cycle` runs the sweeps to completion (fetches,
   extraction, titles, claims), which is what the minute tick does in production.

`ENV=test` is what turns on the outbox and the cycle route, and it lets tela-jobs fetch from
private addresses. Nothing deployed sets it. `.dev.vars` is gitignored.

### End-to-end, local-first stack (`bun run e2e:reader`)

`apps/reader/e2e/run.sh` builds tela-web and starts the fixture feed server. It then runs the
built tela-web, tela-api and tela-jobs in one `wrangler dev`, on fresh local D1, R2 and queues
under `.e2e-logs/reader/state`, and runs Playwright. `e2e/stack.ts` writes the three configs with
the test vars inlined: a secondary Worker reads its vars from its own directory, and writing
`.dev.vars` beside the real configs would clobber a developer's own.

- **Sign-in is real.** The global setup invites a member, reads the code from the outbox, and
  signs in. The member follows two fixture feeds, which the setup fetches with one cycle.
- **Ports:** `E2E_READER_PORT` (8811), `E2E_FIXTURE_PORT` (4790), `E2E_INSPECTOR_PORT` (9311). The
  script refuses to start if one is already taken: a stack left running would answer the health
  check, and every spec would test it instead.
- **Logs:** `.e2e-logs/reader/{build,workers,fixtures}.log`; traces in `apps/reader/test-results`.
- `bun run e2e` runs the Postgres app's suite first, then this one. CI runs both.

### Cloudflare: tela-web, the new edge Worker (`refactor/local-first`, deployed at cutover)

`apps/reader/wrangler.jsonc`. The Next.js app holds the name `tela-web` until phase 8 replaces it.
It has no D1 binding: `BLOBS` is `tela-content` (read-only here) and `API` is tela-api.

- **Secret:** `AUTH_SECRET`, the **same value** as tela-api's. It verifies the signed session
  cache; a different value means every content request falls back to a session read.
- **Var:** `TELA_PRIVATE_BETA=1` serves `Disallow: /` and adds `X-Robots-Tag: noindex, nofollow`
  to everything (ADR 0015).
- **Images:** `/img/<contentKey>/<i>` fetches only what a content object names, over
  `global_fetch_strictly_public`. A broken image is the origin's answer, which the Worker logs
  show; nothing is signed, so there is no secret to rotate.
- **Deploy:** `cd apps/reader && bunx vite build && wrangler deploy`. Vite builds the SPA and the
  Worker together and writes the config wrangler deploys (`dist/tela_web/wrangler.json`).
- **Public pages** (Discover, `/s/:id`, `/@handle`) are rendered here and kept in each colo's
  cache for five minutes, keyed by locale and by the build. So a deploy never serves a page that
  names scripts it removed, and a blog's change shows within five minutes. There is nothing to
  purge.
- **Writes to `/api/*` without this origin get 403** `cross-origin write refused`. Hubs
  (`/api/websub/*`) and the admin script (`/api/admin/*`) are exempt. A browser always sends
  `Origin` on a POST, so seeing this from the app means something is proxying it.
- **The app shell** is cached by a service worker (`public/sw.js`), for fast repeat visits. If a
  bad shell ships and a fix does not reach readers, because their cached shell never asks, use
  the kill switch:
  1. `cp apps/reader/shell/kill-sw.js apps/reader/public/sw.js`, then build and deploy.
  2. On their next visit, browsers install it. It drops every cached shell, unregisters itself,
     and reloads open tabs from the network.
  3. Restore `public/sw.js` with the next deploy.

  A shell older than the sync protocol clears itself anyway: tela-api answers it 409 `upgrade`.

### Cloudflare: tela-api (`refactor/local-first`, not deployed yet)

Sign-in, sync, mutations and every reader RPC (ADR 0024). The config is `apps/api/wrangler.jsonc`.
It uses the same D1 database and `tela-content` bucket as tela-jobs, and only produces to the
jobs queues.

- **Secrets** (`cd apps/api && wrangler secret put …`):
  - `AUTH_SECRET`: 32+ random bytes, e.g. `openssl rand -base64 48`. It signs sessions and the
    five-minute cookie cache, and tela-web must hold the same value to read that cache.
    Rotating it signs everyone out.
  - `ADMIN_TOKEN`: the bearer token for `/api/admin/*`. Unset, those routes answer 403.
  - `RESEND_API_KEY`: a sending-only Resend key for the verified domain. Without it, sending a
    code fails loudly rather than pretending.
- **Vars:** `PUBLIC_URL` (the one public origin, better-auth's base URL and trusted origin) and
  `MAIL_FROM`.
- **Deploy order:** tela-jobs first. tela-api's `JOBS` service binding names its `Ingest`
  entrypoint, which carries discovery, adding a feed, starting a claim and reading OPML; the
  binding fails to resolve until tela-jobs exports it.
- **Invite a member:** `ADMIN_TOKEN=… bun run admin invite reader@example.com`. It creates the
  account and its profile, and mails a code; inviting an existing address only mails a fresh
  code. Registration is otherwise closed (ADR 0015's policy).
- **Sign-in trouble:**
  - Codes last an hour and allow three attempts. The sign-in endpoint allows three tries a
    minute per address; past that the login page says "Too many tries", not "wrong code".
  - `select key, count, last_request from rate_limit` shows better-auth's windows. Tela's own
    action limits are `action_limits`.
  - A code that never arrives: check Resend's log for the address first, then the Worker's logs
    for the send error.
- **Sessions** last 60 days. A signed copy is trusted for five minutes, so a signed-out session
  can linger that long on a device that kept the cookie.

### Cloudflare: tela-jobs (`refactor/local-first`, not deployed yet)

The background Worker that replaces the Fly worker at cutover (ADR 0020). The config is
`apps/jobs/wrangler.jsonc`.

**Resources, once per account:**

- `wrangler d1 create tela --location apac`. The primary lands in Singapore; put its id into
  `apps/jobs/wrangler.jsonc`.
- `wrangler r2 bucket create tela-content` for members-only content objects. `tela-assets`
  already exists (public favicons, behind `assets.<domain>`).
- `wrangler queues create tela-fetch`, and the same for `tela-extract`, `tela-translate`,
  `tela-misc` and the alarm-only DLQ `tela-dlq`.
- Schema: `cd apps/jobs && wrangler d1 migrations apply tela --remote`. The files are
  `packages/data/migrations`, the same SQL the tests apply on libSQL. Until the first deploy,
  `0000_init` is regenerated in place rather than stacked.
- Secrets: none for the relay. `RELAY_SECRET` (with `RELAY_URL` as a var) is set only if a relay
  box is ever provisioned; see *When to provision the relay* below.
- Vars: `WORKER_USER_AGENT`, `FETCH_TIMEOUT_MS`, `WEBSUB_ENABLED`, `PUBLIC_URL`, as in the
  environment table.
- Translation: `wrangler secret put BAILIAN_API_KEY`. The key is a mainland one, so leave
  `BAILIAN_BASE_URL` unset (`dashscope.aliyuncs.com`; the international endpoint refuses it).
  Vars `LLM_DAILY_BUDGET_TOKENS` (background titles; production ran 2,000,000) and
  `LLM_MAX_ARTICLE_TOKENS` (default 40,000). Without a key the translation kinds are disabled,
  never run on the mock: set `LLM_PROVIDER=mock` deliberately, for local runs only.

**Where it runs.** `placement.region = aws:ap-southeast-1` pins the fetch handler beside the D1
primary. The cron (`* * * * *` tick, `17 3 * * *` daily) and the queue consumers run elsewhere
and only call `SELF.fetch()`. The Worker has no public route.

**Day 2, all plain SQL** (`wrangler d1 execute tela --remote --command "…"`):

- **What is held right now:** `select kind, key, owner, until, attempts, last_error from leases`.
  A row with `until = 0` is backing off until `not_before`.
- **What gave up:** `select * from dead_letters order by at desc limit 20`. Nothing retries a
  dead letter. Fix the cause, then make the domain row due again. Examples:
  - a feed: `update feeds set next_fetch_at = 0 where id = …`;
  - an article to re-extract: `update articles set extract_state = 'due' where id = …`.

  A dead letter whose error reads "died or overran its lease" never reported back: every attempt
  was killed or outran its TTL. The cause is in the Worker's logs, not the table: look for
  `exceededCpu`, `exceededMemory` or a wall-clock limit on `/jobs/run` for that key
  (`wrangler tail tela-jobs --format json`, or the dashboard's observability tab).
- **Is the tick alive:** `select * from ops_heartbeats`. `tick.at` moves every minute, and
  `info` holds what it claimed per kind. It counts only the tick's own claims: after each success
  a job claims the next due item on its host itself, so a backlog on one host drains in a chain
  that `info` never shows.
- **Fetch a feed now:** `update feeds set next_fetch_at = 0 where id = …`. The next tick claims
  it; a live lease is never stolen.
- **Translation spend:** `select * from usage_daily order by day desc limit 14` (subject `'*'` is
  background titles, anything else a member), and per call `select job, count(*),
  sum(input_tokens), sum(output_tokens) from llm_calls where created_at > … group by job`.
- **Retranslate titles:** `delete from article_titles where article_id in (…)`; the sweep finds
  them again. **A stuck body:** `select * from body_translations where state in ('requested',
  'running')`. A row stays `running` between executions of one request and needs nothing; one
  that exhausted its attempts is `failed`, with its dead letter beside it.
- Queue messages are only accelerators. Purging a queue loses no work, because the next tick
  finds everything still due.

**The relay** is its own image: `docker build -f apps/relay/Dockerfile -t tela-relay .`. Run it
with `RELAY_SECRET` (and `RELAY_SECRET_PREVIOUS` while rotating) behind the TLS proxy described
in the relay runbook.

**When to provision the relay.** Not until a feed needs it. Without `RELAY_URL` nothing ever
moves to the relay, but each feed still counts consecutive timeouts:
`select id, feed_url, timeout_streak, last_error from feeds where timeout_streak >= 3`. A feed
that stays in that list while the rest of the web answers (a mainland host Cloudflare cannot
reach) is the reason to run the box. Build the image, deploy it on an HK box as the relay
runbook says, and set `RELAY_URL` and the `RELAY_SECRET` secret on `tela-jobs`. The next
timeouts move those feeds over on their own.

## End-to-end tests

`bun run e2e` (`apps/web/e2e/run.sh`) starts a throwaway Postgres (or uses `E2E_DATABASE_URL`),
a fixture feed server, seeds two feeds for the development user, builds and starts the worker and
the web app in dev-auth mode, and runs Playwright. Logs land in `.e2e-logs/`; failing tests leave
traces in `apps/web/test-results/`. CI runs the same script against a Postgres service container.
First run: `cd apps/web && bunx playwright install chromium`.

## Local development

- Web: `cp apps/web/.env.example apps/web/.env`, set `DATABASE_URL`, `bun run dev`. **That file
  and `cd apps/web && bun run deploy` do not mix**: `next build` loads `.env*` and inlines what it
  finds, and `getDb` prefers an explicit `DATABASE_URL` over the HYPERDRIVE binding, so a deploy
  from a checkout you also develop in dials a database that is not there and every request fails.
  It is silent — `.env` is gitignored, so `git status` stays clean and `git checkout` on it does
  nothing. `apps/web/scripts/preflight-deploy.ts` now refuses such a deploy; move the file aside
  (`mv apps/web/.env apps/web/.env.localdev`) and put it back afterwards.
- Cloudflare runtime locally: `cd apps/web && bun run preview` (uses `localConnectionString` from
  `wrangler.jsonc` for Hyperdrive).
- Worker: `cp apps/worker/.env.example apps/worker/.env`, `bun run dev:worker`.
- Tests: `bun run test`. DB tests start a throwaway cluster with the local `initdb`; install
  Postgres with `brew install postgresql@17` or set `TEST_DATABASE_URL`.
- No Docker: `bun run db:local --port 54322` starts a migrated Postgres with the development user
  and prints `DATABASE_URL`; with `TELA_DEV_AUTH=1` in `apps/web/.env` the app signs you in as that
  user. `bun run db:prepare` applies the same setup to an existing database.

## Runbooks

### Worker
- Logs are JSON lines on stdout/stderr. `feed fetch failed` lines carry `kind` (`timeout`,
  `network`, `http_429`, `parse`, …) and the feed id.
- **Fetch one feed now**: `DATABASE_URL=… bun run worker:once fetch <feedUrl>` (creates the feed if
  needed). `… discover <url>` prints candidates; `… extract <articleId>` runs Readability. If the
  worker has not created pg-boss yet, fetch still stores the feed and warns that no title jobs
  were queued.
- **Revive a dead feed**: `update feeds set status = 'active', error_count = 0, next_fetch_at =
  now() where id = …`. The daily maintenance job does this automatically after seven days.
- **Inspect the queue**: `select name, policy from pgboss.queue`; failed jobs land in
  `<queue>.dead` and stay for 30 days.
- The queue schema (`pgboss`) is created by the worker on first start; migrations do not manage it.
  On every start `ensureQueues` creates missing queues and updates the mutable settings of
  existing ones. A queue's *policy* is fixed at creation: if the code changes one, the worker
  refuses to start with "queue … has policy …; recreate it". Drain the queue, `select
  pgboss.delete_queue('<name>')`, and restart.
- **Health check**: every five minutes (and at startup) the scheduler role logs one `health check`
  line with per-queue counts (`queued`, `active`, `retrying`, `done1h`, `failed1h`, `oldestSec`),
  feed counts (`active`, `paused`, `dead`, `overdue`, `relayed`) and a `problems` list. It is
  `warn` level when a dead-letter queue holds jobs, a queue failed jobs in the last hour, the
  oldest waiting job is older than ten minutes, or active feeds are more than fifteen minutes
  overdue. Alert on `level=warn msg="health check"`; the web's `/api/health` covers the app.
- **Alert playbook**: `*.dead` growing → `select data, output from pgboss.job where name = '<queue>.dead'
  order by created_on desc limit 20`, fix the cause, then re-send with `boss.send` or delete the
  rows; `overdue` feeds → the fetch role is down or too slow (raise `FETCH_CONCURRENCY` or add a
  fetch instance); `oldestSec` high on `translate.body` → the provider is slow or the daily budget
  is exhausted (`LLM_DAILY_BUDGET_TOKENS`).
- **Drain a dead letter once you have dealt with it.** `problems` flags a dead-letter queue that
  holds *any* job, so one job left lying around keeps every health line at `warn` for its full
  30-day retention and the signal is gone. Check the work was covered another way — for a title,
  `select title from article_translations where article_id = …` — then
  `delete from pgboss.job where name = '<queue>.dead' and id = '<id>'`.

### WebSub
- Turn on with `WEBSUB_ENABLED=1` on the fetch/scheduler workers once `PUBLIC_URL` is the real
  origin; hubs verify by calling `<PUBLIC_URL>/api/websub/<feedId>`.
- **State**: `select feed_id, status, lease_until, last_error from websub_subscriptions order by
  lease_until`. `failed` rows retry weekly, `pending` ones that were never verified retry daily,
  `active` leases renew two days before they end.
- **Force a resubscribe**: `delete from websub_subscriptions where feed_id = …`; the next fetch of
  that feed requests a new subscription.
- Pings only enqueue a fetch, so a misbehaving hub cannot inject content; a bad signature is a 403
  in the web logs.

### Relay (China fetch)
- **Deploy**: run the worker image with `WORKER_ROLES=relay RELAY_SECRET=<32+ random chars>` on a
  Hong Kong (or mainland) box; no `DATABASE_URL`. Put it behind TLS (Caddy, or the provider's
  load balancer) and check `GET /healthz`. Then set `RELAY_URL=https://relay.<domain>` and the
  same `RELAY_SECRET` on the global worker and restart it.
- **Which feeds use it**: `select id, feed_url, region_flipped_at, timeout_streak from feeds where
  fetch_region = 'cn'`. Worker logs show `feed routed through the relay` when a feed flips.
- **Force a feed onto or off the relay**: `update feeds set fetch_region = 'cn', region_flipped_at
  = now() where id = …` (or `'global'`). The daily maintenance job re-probes `cn` feeds from the
  global region after seven days; a feed that times out three more times flips back by itself.
- **Rotate the secret**: on the relay set `RELAY_SECRET_PREVIOUS` to the current value and
  `RELAY_SECRET` to the new one, restart; then set the new `RELAY_SECRET` on the global worker,
  restart; finally remove `RELAY_SECRET_PREVIOUS` from the relay. Signatures expire after five
  minutes, so keep both boxes' clocks in sync (NTP).
- **It is not an open proxy**: only signed `POST /fetch` requests are served, private ranges are
  refused, redirects are not followed, the upstream body is capped at 5 MB, and a request larger than 64 KiB is refused before it is read (the signature covers the body, so that cap is the only pre-authentication limit).

### Auth
- **What the project actually allows**, without the Dashboard: `curl -s
  "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/settings" -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"`.
  `external.email` must be `true` (email sign-in works) and `disable_signup` must be `true`
  (registration closed) while Tela is in private testing. Both false-negatives are silent from the
  outside: a locked-out member sees a login page that looks fine.
- **Nobody can sign in**: check `external.email` first. If it is `false`, `[auth.email]
  enable_signup` is `false` in `config.toml` — that is the provider switch, not a signup switch.
  Set it `true` and push (ADR 0015). GoTrue answers `POST /auth/v1/otp` with 422
  `email_provider_disabled` in that state, and 422 `otp_disabled` for a genuinely unknown address.
- **A member says they have no account** but the row exists: confirm with `select email,
  last_sign_in_at from auth.users where email = '…'`, then compare the two 422s above — the app
  keys its message on the error code (`apps/web/src/lib/login-error.ts`), not the status.

### Web
- **Rate limits**: rules live in `RATE_LIMITS` (`packages/db/src/queries/rate-limit.ts`); change a
  number and redeploy. To lift a member's block early: `delete from rate_limits where key like
  'discover:<user id>%'` (keys are `<action>:<user id>`). Closed windows are pruned daily by the
  worker's maintenance job; the table is service-role only.
- **Search** needs the `pg_trgm` extension (migration 0007 creates it and the GIN indexes). On
  Supabase the extension is preinstalled; on a fresh Postgres install the contrib package. If
  search gets slow, `reindex index concurrently articles_title_trgm_idx` after large backfills.

### Translation
- **Cost check**: `select date_trunc('day', created_at) d, model, sum(input_tokens) i, sum(output_tokens) o, count(*) from llm_usage group by 1, 2 order by 1 desc`.
- **Budget**: set `LLM_DAILY_BUDGET_TOKENS` on the worker; once exceeded, title jobs that miss
  the cache are re-queued for the next UTC day, reader-initiated body requests still run (each
  member gets 30 per hour and `USER_DAILY_TRANSLATION_TOKENS` a day, metered per member in
  `llm_usage.user_id`).
- **Switch provider**: change `LLM_PROVIDER`/`LLM_MODEL` and the key; restart the worker. Cached
  translations keep their `model` label, so old and new output can be compared.
- **Force a retranslation** of an article: `delete from article_translations where article_id = …`
  (the block cache stays; use `delete from translations where model = '…'` to drop a model's output).
- **Find posts with no translated title**, the shape a silently-failed or never-queued title job
  leaves behind — there is no job row to inspect, so the articles themselves are the only record:

  ```sql
  select a.id, a.feed_id, a.title, a.source_lang, l.lang
  from articles a
  join feeds f on f.id = a.feed_id
  join sites s on s.id = f.site_id
  cross join (values ('zh-Hans'), ('en')) l(lang)
  left join article_translations t on t.article_id = a.id and t.target_lang = l.lang
  where a.source_lang is distinct from l.lang
    and not s.translation_opt_out
    and (t.article_id is null or t.title is null);
  ```

  With the translate worker running, queue a newest-first batch with
  `DATABASE_URL=… bun run worker:once repair-titles [limit]`. The default is 500 pairs and the
  maximum is 5,000. The whole batch is one `INSERT … SELECT`, so a 5,000-pair run is one round
  trip; the JSON result reports `enqueued`.

  It is safe to run beside the worker: candidates exclude every pair that already has a job in
  `created`, `retry` or `active`, which the singleton key alone would not — pg-boss's `short`
  policy dedups created jobs only. Losing the remaining race costs one duplicate provider call:
  read committed still allows a job to be activated between the statement's snapshot and its
  insert, and nothing can prevent that under `short` (excluding active jobs would need the
  `exclusive` policy, which would break the budget-deferral re-send and take a queue migration).

  `enqueued: 0` means "nothing missing and idle", not "all titles are in": let `translate.title`
  drain, then rerun, and a repeat `enqueued: 0` with an empty queue is done. Titles that keep
  coming back are failing, not queueing — check `translate.title.dead` and the worker's
  `title translation failed` lines. The command skips sites that opted out and refuses to run
  before the worker has created the queue. Never insert into `pgboss.job` by hand.
- **Add a reading language**: append it to `READING_LANGUAGES` in `packages/shared`, add the
  name to `LANGUAGE_NAMES`, and (if it is also a UI locale) a message catalog.
- **Spot-check quality**: `LLM_PROVIDER=bailian BAILIAN_API_KEY=… bun run --filter @tela/llm spot-check`
  translates a few fixture paragraphs and prints them side by side.

### Later
- Rotating the image-proxy signing key: set a new `IMAGE_PROXY_SECRET`; old proxy URLs stop
  verifying and pages regenerate them on the next render.
- Before switching readers to the custom domain: the Supabase redirect allow-list and `site_url`
  step above, then sign in once with each provider from the new origin.
- Before launch: the Data API is off (`[api] enabled = false`, Provisioning step 5).
- To open Tela up: `enable_signup = true` under **`[auth]`** in `supabase/config.toml` and
  `supabase config push`; remove `TELA_PRIVATE_BETA` from `apps/web/wrangler.jsonc` and deploy.
  Leave `[auth.email] enable_signup` alone — it is the provider switch, not a signup switch, and
  setting it `false` locks existing members out (ADR 0015).
- Move the worker to the next Node LTS **after 2026-10-28**, when Node 26 reaches LTS; Node 24 <!-- node-pin:planned -->
  enters maintenance on 2026-10-20, so the two dates make one clean move (support then runs to <!-- node-pin:planned -->
  2029-04 instead of 2028-04). Five pins have to change together — `.node-version`, `engines`,
  the Dockerfile runtime stage, the CI `node-version` and `@types/node` — plus the Node major the
  living docs name; `test/docs.test.ts` fails until they all agree. Deliberately not done early:
  ADR 0001 runs the worker on the current LTS, and Node 26 is still Current until that date. <!-- node-pin:planned -->
- China checks from a HK/CN box (custom auth domain, image proxy for `mmbiz.qpic.cn`-style hosts)
