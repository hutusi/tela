# Operations

How Tela is provisioned and deployed. Sections marked *later* are filled in by the phase that
implements them (see `docs/ARCHITECTURE.md`).

## Environments

| Component | Where | Notes |
|---|---|---|
| Web | Cloudflare Workers via OpenNext (`apps/web`) | Custom domain only; never share `workers.dev` URLs (blocked in mainland China) |
| Database + Auth | Supabase, region Tokyo (`ap-northeast-1`) | IPv4 add-on for the direct connection; custom SMTP (Resend); custom auth domain *later* |
| Worker | Fly.io app `tela-worker`, region `nrt` (`apps/worker`) | Docker image, Node 22; roles via `WORKER_ROLES` |
| Relay | HK or CN box running the same image with `WORKER_ROLES=relay` | *later*, phase 8 |
| Assets | Cloudflare R2 bucket behind `assets.<domain>` | favicons and covers; *later*, phase 3 |

## Environment variables

| Name | Used by | Meaning |
|---|---|---|
| `DATABASE_URL` | worker, web (local / non-Cloudflare) | Postgres connection string. On Cloudflare the `HYPERDRIVE` binding replaces it. |
| `WORKER_ROLES` | worker | Comma list of roles; default is every role except `relay` |
| `LOG_LEVEL` | worker | `debug` / `info` / `warn` / `error` |
| `LLM_PROVIDER` | worker | `bailian` (default), `anthropic`, or `mock`; without the matching key the mock is used |
| `LLM_MODEL` | worker | Model id: `glm-5.2` (Bailian default), `claude-opus-5` (Anthropic default) |
| `BAILIAN_API_KEY`, `BAILIAN_BASE_URL` | worker | Aliyun Bailian key; base URL defaults to `https://dashscope.aliyuncs.com/compatible-mode/v1` (use the workspace/region host from the console when required) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | worker | Anthropic key; base URL optional |
| `LLM_JSON_MODE` | worker | `text` (parse JSON from the reply; default for Bailian) or `schema` (structured output; default for Anthropic) |
| `LLM_DAILY_BUDGET_TOKENS` | worker | Daily cap for background translation; `0` = unlimited; on-demand requests always run |
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
| `TELA_ALLOW_PRIVATE_HOSTS`, `WORKER_ALLOW_PRIVATE_HOSTS` | tests only | let discovery/fetch reach localhost fixture servers |
| `NEXTJS_ENV` | web (`.dev.vars`) | Which `.env` files OpenNext loads locally |
| `TEST_DATABASE_URL`, `PG_BIN_DIR` | tests | Use an existing database, or point at Postgres binaries |

## Provisioning

### Supabase
1. Create a project in Tokyo. Enable the IPv4 add-on (Project Settings → Add-ons) so Hyperdrive can
   use the *direct* connection string (not the pooler).
2. Auth → SMTP: configure Resend (built-in SMTP is capped at 2 emails/hour). Verify delivery to
   qq.com and 163.com addresses.
3. Auth → Providers: Email (OTP), GitHub, Google (phase 4).
4. Apply migrations: `DATABASE_URL=<direct connection> bun run db:migrate`.

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
- Hyperdrive needs an IPv4 origin. Until the Supabase IPv4 add-on is on, point it at the
  *session* pooler (`postgres.<ref>@aws-0-<region>.pooler.supabase.com:5432`, prepared statements
  work in session mode); afterwards recreate it with the direct connection, which is what
  Cloudflare recommends for Supabase. Hyperdrive's own endpoint is plain TCP: the client must
  not ask for TLS there (`sslModeFor` in `@tela/db` handles `*.hyperdrive.local`).
- The first request after a deploy can wait up to the driver's 30 s connect timeout while
  Hyperdrive opens its origin connection; `/api/health` reports `databaseMs` and the error text.
- Then add the custom domain under Workers & Pages → tela-web → Settings → Domains.

R2 for favicons and covers: `bunx wrangler r2 bucket create tela-assets --location apac`, then
either connect a custom domain (`assets.<domain>`) under the bucket's settings or, before a
domain exists, `bunx wrangler r2 bucket dev-url enable tela-assets` (rate-limited, fine for
previews). Create an R2 API token with object read/write in the dashboard (R2 → Manage API
tokens; wrangler cannot), set the `R2_*` variables on the worker, and
`NEXT_PUBLIC_ASSETS_URL` on the web app.

### Curation
- Feature a site: `update sites set listing = 'featured' where id = …`; hide one: `'rejected'`.
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
  example to hold back `translate` until the LLM key exists (the mock provider would otherwise
  write placeholder translations into the shared cache).
- Logs: `fly logs --app tela-worker`; the JSON lines are the same as locally.

## End-to-end tests

`bun run e2e` (`apps/web/e2e/run.sh`) starts a throwaway Postgres (or uses `E2E_DATABASE_URL`),
a fixture feed server, seeds two feeds for the development user, builds and starts the worker and
the web app in dev-auth mode, and runs Playwright. Logs land in `.e2e-logs/`; failing tests leave
traces in `apps/web/test-results/`. CI runs the same script against a Postgres service container.
First run: `cd apps/web && bunx playwright install chromium`.

## Local development

- Web: `cp apps/web/.env.example apps/web/.env`, set `DATABASE_URL`, `bun run dev`.
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
  needed). `… discover <url>` prints candidates; `… extract <articleId>` runs Readability.
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
  refused, redirects are not followed, and the body is capped at 5 MB.

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
- **Budget**: set `LLM_DAILY_BUDGET_TOKENS` on the worker; background title work stops for the
  day once exceeded, reader-initiated body requests do not.
- **Switch provider**: change `LLM_PROVIDER`/`LLM_MODEL` and the key; restart the worker. Cached
  translations keep their `model` label, so old and new output can be compared.
- **Force a retranslation** of an article: `delete from article_translations where article_id = …`
  (the block cache stays; use `delete from translations where model = '…'` to drop a model's output).
- **Add a reading language**: append it to `READING_LANGUAGES` in `packages/shared`, add the
  name to `LANGUAGE_NAMES`, and (if it is also a UI locale) a message catalog.
- **Spot-check quality**: `LLM_PROVIDER=bailian BAILIAN_API_KEY=… bun run --filter @tela/llm spot-check`
  translates a few fixture paragraphs and prints them side by side.

### Later
- Rotating the image-proxy signing key: set a new `IMAGE_PROXY_SECRET`; old proxy URLs stop
  verifying and pages regenerate them on the next render.
- China checks from a HK/CN box (custom auth domain, image proxy for `mmbiz.qpic.cn`-style hosts)
