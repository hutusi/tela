# Operations

How Tela is provisioned, deployed and kept running: three Cloudflare Workers, D1, R2 and Queues
(ADRs 0020–0027). Until the cutover below, tela.ainaive.com still serves the Postgres app from
`main`; this branch is the stack that replaces it.

## Environments

| Component | Where | Notes |
|---|---|---|
| tela-web | Worker at the reader's edge, unpinned (`apps/reader`) | The only public Worker: static SPA, public pages, `/o/*`, `/img/*`, the `/api/*` forward. Custom domain only; `workers.dev` stays off (blocked in mainland China) |
| tela-api | Worker pinned to `aws:ap-southeast-1` (`apps/api`) | Sign-in, sync, mutations, every reader RPC. No public route: tela-web reaches it over a service binding |
| tela-jobs | Worker pinned to `aws:ap-southeast-1` (`apps/jobs`) | Crons, queue consumers, the `Ingest` RPC. No public route |
| D1 `tela` | Primary in Singapore (`--location apac`) | 6–10 ms from the pinned Workers; Time Travel keeps 30 days |
| R2 `tela-content` | Private | Content, translation and chunk objects (served by tela-web to members), raw item HTML, and the nightly `backup/` |
| R2 `tela-assets` | Public at `assets.tela.ainaive.com` | Favicons |
| Queues | `tela-fetch`, `tela-extract`, `tela-translate`, `tela-misc`, DLQ `tela-dlq` | Accelerators only: every job is also found from state by the minute sweep |
| Relay | Not provisioned (`apps/relay`) | A Node box in HK, only once a feed times out from Cloudflare; see *The relay* |
| Outside | Resend (mail), Bailian (translation), healthchecks.io (the dead-man's switch) | |

## Environment variables and secrets

Vars live in each `wrangler.jsonc`; secrets are set with `wrangler secret put <NAME>` in that app's
directory.

| Name | Worker | Meaning |
|---|---|---|
| `AUTH_SECRET` | tela-api, tela-web (secret) | 32+ random bytes (`openssl rand -base64 48`). Signs sessions and the five-minute cookie cache; **the same value on both**, or every content request falls back to a session read. Rotating it signs everyone out |
| `ADMIN_TOKEN` | tela-api (secret); the admin script | Bearer token for `/api/admin/*`. Unset, those routes answer 403 |
| `RESEND_API_KEY` | tela-api, tela-jobs (secret) | Sending-only Resend key for the verified domain: sign-in codes (api) and the weekly digest (jobs). Without it, api fails a code loudly and jobs skips the digest |
| `MAIL_FROM` | tela-api, tela-jobs | Sender, `Tela <noreply@ainaive.com>` |
| `PUBLIC_URL` | tela-api, tela-jobs | The one public origin: better-auth's base URL and trusted origin, claim `rel="me"` targets, the WebSub callback |
| `TELA_PRIVATE_BETA` | tela-web | `1`: robots.txt disallows everything and every response the Worker serves carries `X-Robots-Tag: noindex, nofollow` (ADR 0015). The SPA shell is a static asset the Worker never sees, so it is noindex by its own meta tag, always: it is the app, with nothing of its own to index. Public pages drop that tag and follow this var |
| `ENV` | tela-api, tela-jobs | `test` in local dev and e2e only: the sign-in outbox, `POST /api/test/cycle`, and fetches to private addresses. Never deployed |
| `WORKER_USER_AGENT` | tela-jobs | Sent on every fetch; keep a contact URL in it |
| `FETCH_TIMEOUT_MS` | tela-jobs, the relay | Per-request timeout, default 20000 |
| `WEBSUB_ENABLED` | tela-jobs | `1` subscribes at feeds' hubs; hubs verify by calling `PUBLIC_URL/api/websub/<feedId>` |
| `LLM_PROVIDER` | tela-jobs | `bailian` (default), `anthropic` or `mock`. Without the matching key the provider falls back to the mock, and the translation kinds are then disabled rather than caching placeholder output; set `mock` on purpose for local runs only |
| `LLM_MODEL` | tela-jobs | `glm-5.2` (Bailian default), `claude-opus-5` (Anthropic default) |
| `BAILIAN_API_KEY`, `BAILIAN_BASE_URL` | tela-jobs (key secret) | The key is a mainland one: leave the base URL unset (`dashscope.aliyuncs.com`; the international endpoint refuses it) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | tela-jobs (key secret) | Anthropic, if ever used |
| `LLM_JSON_MODE` | tela-jobs | `text` (parse JSON from the reply; Bailian's default) or `schema` (structured output; Anthropic's) |
| `LLM_DAILY_BUDGET_TOKENS` | tela-jobs | Day cap for background title translation; `0` = unlimited. Production ran 2,000,000. Reader requests are metered per member instead |
| `LLM_MAX_ARTICLE_TOKENS` | tela-jobs | Source tokens translated per body (default 40,000); the rest stays as source and the translation is `partial` |
| `LLM_MOCK_DROP_MARKER` | tela-jobs, tests only | With `LLM_PROVIDER=mock`, the mock drops every block containing this text, so a run can reach `partial` |
| `RELAY_URL`, `RELAY_SECRET` | tela-jobs (secret) | The relay's origin and shared signing secret. Unset (as now): feeds never change region |
| `RELAY_CONTROL_URL` | tela-jobs | Fetched before flipping a feed to the relay; if it fails too, the problem is Cloudflare's network, not the feed (default: Cloudflare's trace endpoint) |
| `RELAY_SECRET`, `RELAY_SECRET_PREVIOUS`, `RELAY_PORT` | the relay | Accepted secrets (the previous one during rotation) and the listen port (8787) |
| `DEADMAN_URL` | tela-jobs (secret) | The healthchecks.io ping URL; see *Knowing it runs* |
| `DIGEST_TO` | tela-jobs (secret) | Who gets the Monday digest (the owner). Unset, it is built but not sent |
| `VITE_ASSETS_URL` | tela-web build | Public base of `tela-assets`; defaults to `https://assets.tela.ainaive.com` |
| `TELA_URL` | the admin script | Where `bun run admin` talks to; defaults to `https://tela.ainaive.com` |

## Provisioning, once per account

The account is on Workers Paid. Run wrangler from a real terminal (`wrangler login` needs a TTY).

1. **D1:** `wrangler d1 create tela --location apac`. Put its id into both
   `apps/api/wrangler.jsonc` and `apps/jobs/wrangler.jsonc` (ids are not secrets). The hint says
   Asia-Pacific, not Singapore, and tela-api and tela-jobs are pinned to Singapore, so check where
   the primary landed before anything is written to it:
   `wrangler d1 execute tela --remote --json --command "select 1"` reports `served_by_colo`. If it
   is not `SIN`, delete the empty database and create it again: production's landed in NRT, then
   HKG, then SIN, and every statement from the pinned Workers pays that distance (6–10 ms beside
   it, about 35 from HKG, 70 from NRT).
2. **R2:** `wrangler r2 bucket create tela-content --location apac`, and a lifecycle rule for the
   streamed-translation chunks, which are only read while a translation runs:
   `wrangler r2 bucket lifecycle add tela-content chunks tc/ --expire-days 7`. `tela-assets`
   already exists, behind `assets.tela.ainaive.com`.
3. **Queues:** `wrangler queues create tela-fetch`, and the same for `tela-extract`,
   `tela-translate`, `tela-misc` and the alarm-only `tela-dlq`.
4. **Schema:** `cd apps/api && wrangler d1 migrations apply tela --remote`. The files are
   `packages/data/migrations`, the SQL the tests apply on libSQL and in workerd. New ones come from
   `bun run db:generate`; review the SQL and commit it.
5. **Secrets:** `AUTH_SECRET` on tela-api and tela-web (the same value); `ADMIN_TOKEN` and
   `RESEND_API_KEY` on tela-api; `BAILIAN_API_KEY`, `RESEND_API_KEY`, `DIGEST_TO` and `DEADMAN_URL`
   on tela-jobs.
6. **The dead-man's switch:** a healthchecks.io check with a 5-minute period and a 15-minute grace
   (a cron tick is occasionally skipped), alerting the owner by email. Its ping URL is
   `DEADMAN_URL`.
7. **Deploy, in this order:**
   1. `cd apps/jobs && wrangler deploy`. tela-api's `JOBS` binding names its `Ingest`
      entrypoint, which does not resolve until tela-jobs exports it.
   2. `cd apps/api && wrangler deploy`.
   3. `cd apps/reader && bunx vite build && wrangler deploy`. Vite builds the SPA and the Worker
      together and writes the config wrangler deploys (`dist/tela_web/wrangler.json`). The
      custom domain is the `routes` entry in `apps/reader/wrangler.jsonc`, so the deploy claims
      tela.ainaive.com itself.

   **A release that bumps `MIN_CLIENT` reverses the last two:** tela-web first, then tela-api
   within minutes. A shell on the new protocol still works against the old tela-api, but the new
   tela-api tells every older shell to upgrade, and one whose reload finds no newer shell to load
   stalls until it is navigated. So the newer shell must already be live. Roll back in the same
   spirit: tela-api may go back alone; tela-web may not go back while the new tela-api is live.

## Cutover from the Postgres app

One time. Production holds test data only, so nothing is migrated: the owner's subscriptions
travel as OPML, and Discover is curated again. Steps 2–5 ran on 2026-09-29, with Gate G2's full
compare and step 1's cleanup left to finish beside the new stack; steps 6–9 are still open.

1. **Gate G2 passed:** the shadow tela-jobs matched the Fly worker's articles by dedup key. Then
   delete the shadow's Worker `tela-jobs-shadow`, D1 `tela-shadow`, bucket `tela-content-shadow`
   and queues `tela-shadow-*`, and the `env.shadow` block in `apps/jobs/wrangler.jsonc`.
2. **Export the owner's subscriptions** from the running site: Settings → Export OPML.
3. **Provision and deploy** as above. Deploying tela-web replaces the Next Worker of the same name
   on tela.ainaive.com: that is the switch, and it takes effect at once.
4. **Invite and sign in:** `ADMIN_TOKEN=… bun run admin invite <owner email>`, sign in at `/login`,
   and import the OPML on `/add`.
5. **Curate Discover:** `ADMIN_TOKEN=… bun run admin curate`.
6. **Check:**
   - `/api/health` answers `ok`;
   - the imported feeds' posts arrive within a few minutes;
   - Discover lists the curated blogs;
   - a Japanese post translates in chunks;
   - the dead-man check is green;
   - the next morning, `backup/latest.json` says `verified`.
7. **The mainland check** (deferred from spike S5), before any mainland reader is invited:
   itdog.cn or boce.com against `/` and `/api/v1/sync`. If the first sync is painfully slow,
   shrink the initial pull (first page now, the rest behind); that is tuning, not architecture.
8. **Rollback**, while the old stack still exists:
   `wrangler rollback 977f3ab3-e9db-439c-a720-ba5d5e1d1a40 --name tela-web` puts the Next app's last
   version back on the same name and domain; its Hyperdrive binding and secrets are still there.
   Failing that, redeploy it from a checkout of `main` (its `bun run deploy`). The Postgres stack is
   untouched until the next step.
9. **After a quiet week, remove the old stack:**
   - the Fly app `tela-worker` (`fly apps destroy tela-worker`);
   - the Hyperdrive config `tela-db`;
   - the Supabase project (pause it first; delete once nothing asks for it);
   - the R2 API token the Fly worker used.

   Then merge this branch.

## Running locally

`bun run dev` is Vite with the Cloudflare plugin: the SPA with hot reload, tela-web's Worker, and
tela-api and tela-jobs beside it as auxiliary Workers, all in workerd. Service bindings, the
`Ingest` RPC, local queues, D1 and R2 all work, and the three share one local D1 and bucket
because their configs name the same ones.

```sh
S=$(openssl rand -hex 32)
printf "AUTH_SECRET=$S\nADMIN_TOKEN=local\nENV=test\nPUBLIC_URL=http://localhost:5173\n" > apps/api/.dev.vars
printf "ENV=test\nLLM_PROVIDER=mock\nPUBLIC_URL=http://localhost:5173\n" > apps/jobs/.dev.vars
printf "AUTH_SECRET=$S\nTELA_PRIVATE_BETA=1\n" > apps/reader/.dev.vars
apps/reader/node_modules/.bin/wrangler d1 migrations apply tela --local \
  --persist-to apps/reader/.wrangler/state -c apps/api/wrangler.jsonc
bun run dev   # http://localhost:5173
```

Then:
1. Invite: `TELA_URL=http://localhost:5173 ADMIN_TOKEN=local bun run admin invite you@x.test`.
2. Sign in at `/login`, reading the code from `/api/test/outbox?email=you@x.test`.
3. Add a feed on `/add`. The crons do not fire in dev: `curl -X POST -H 'origin:
   http://localhost:5173' localhost:5173/api/test/cycle` runs the sweeps to completion (fetches,
   extraction, titles, claims), which is what the minute tick does in production.

`.dev.vars` is gitignored. Unit tests need nothing: `bun run test` runs on libSQL in memory, and
`bun run test:workers` runs the D1 half in workerd.

## End-to-end

`bun run e2e` (`apps/reader/e2e/run.sh`) builds tela-web and starts the fixture feed server. It
then runs the built tela-web, tela-api and tela-jobs in one `wrangler dev`, on fresh local D1, R2
and queues under `.e2e-logs/reader/state`, and runs Playwright. `e2e/stack.ts` writes the three
configs with the test vars inlined: a secondary Worker reads its vars from its own directory, and
writing `.dev.vars` beside the real configs would clobber a developer's own.

- **Sign-in is real.** The global setup invites a member, reads the code from the outbox, and
  signs in. The member follows two fixture feeds, which the setup fetches with one cycle.
- **A post that changes:** the fixture server's `/changing.xml` serves the version set by `POST
  /__changing?v=1|2|3`, and `POST /api/test/cycle?refetch=1` fetches every feed again at once.
- **Ports:** `E2E_READER_PORT` (8811), `E2E_FIXTURE_PORT` (4790), `E2E_INSPECTOR_PORT` (9311). The
  script refuses to start if one is taken: a stack left running would answer the health check,
  and every spec would test it instead.
- **Logs:** `.e2e-logs/reader/{build,workers,fixtures}.log`; traces in `apps/reader/test-results`.
- First run: `cd apps/reader && bunx playwright install chromium`.

## tela-web

`apps/reader/wrangler.jsonc`. No D1 binding: `BLOBS` is `tela-content` (read-only here) and `API`
is tela-api.

- **Images:** `/img/<contentKey>/<i>` fetches only what a content object names, over
  `global_fetch_strictly_public`. A broken image is the origin's answer, which the Worker logs
  show; nothing is signed, so there is no secret to rotate.
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

## tela-api

`apps/api/wrangler.jsonc`: sign-in, sync, mutations and every reader RPC (ADR 0024). It shares the
D1 database and `tela-content` with tela-jobs, and only produces to the jobs queues.

- **Invite a member:** `ADMIN_TOKEN=… bun run admin invite reader@example.com`. It creates the
  account and its profile, and mails a code; inviting an existing address only mails a fresh
  code. Registration is otherwise closed (ADR 0015's policy).
- **Sign-in trouble:**
  - Codes last an hour and allow three attempts. The sign-in endpoint allows three tries a
    minute per address; past that the login page says "Too many tries", not "wrong code".
  - `select key, count, last_request from rate_limit` shows better-auth's windows.
  - A code that never arrives: check Resend's log for the address first, then the Worker's logs
    for the send error.
- **Sessions** last 60 days. A signed copy is trusted for five minutes, so a signed-out session
  can linger that long on a device that kept the cookie.
- **Rate limits** on reader actions are `ACTION_LIMITS` (`packages/data/src/queries/limits.ts`):
  discover 30/h, subscribe 120/h, OPML import 5/h, claim start 10/h, claim verify 30/h, translate
  30/h. Lift a member's early: `delete from action_limits where key like 'discover:<user id>%'`.

## tela-jobs

`apps/jobs/wrangler.jsonc`. `placement.region = aws:ap-southeast-1` pins the fetch handler beside
the D1 primary. The crons (`* * * * *` sweeps, `17 3 * * *` upkeep and backup, `0 8 * * 1` digest)
and the queue consumers run elsewhere and only call `SELF.fetch()`.

The kinds of work (`src/kinds.ts`), each a domain row that says what is due and a lease that
says who holds it:

| Kind | Due when |
|---|---|
| `feed.fetch` | `next_fetch_at` has passed, or a WebSub ping asked |
| `article.extract` | `extract_state = 'due'`: a summary-only post waiting for its page |
| `site.assets` | a site's favicon has never been checked |
| `site.claim` | a member asked for their claim to be checked |
| `websub.subscribe` | a hub subscription is new, failed, or near its lease's end |
| `translate.title` | a feed has articles without titles in every launch language |
| `translate.body` | a member asked for a post in their language |

**Day 2, all plain SQL** (`wrangler d1 execute tela --remote --command "…"`):

- **What is held right now:** `select kind, key, owner, until, attempts, last_error from leases`.
  A row with `until = 0` is backing off until `not_before`.
- **What gave up:** `select * from dead_letters order by at desc limit 20`. Nothing retries a
  dead letter. Fix the cause, then make the domain row due again:
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
- **Revive a dead feed:** `update feeds set status = 'active', error_count = 0, next_fetch_at = 0
  where id = …`. The nightly upkeep does this itself after seven days.
- **Merged feeds** (ADR 0028): `select id, feed_url, merged_into from feeds where merged_into is
  not null`. A merge moves readers and the posts only the alias had, and deletes nothing. To undo
  a wrong one (a category feed taken for the blog's), reactivate the alias with
  `update feeds set status = 'active', merged_into = null, next_fetch_at = 0 where id = …`.
  Its readers stay on the canonical feed until they subscribe to the alias again.
- Queue messages are only accelerators. Purging a queue loses no work, because the next tick
  finds everything still due.

## Knowing it runs

Nothing here needs watching; three things speak up when something is wrong (ADR 0027).

- **The dead-man's switch.** Every five minutes after the tick, a health check pings
  `DEADMAN_URL` when all is well, and `DEADMAN_URL/fail` with the problems when not. healthchecks.io
  alerts on a `fail`, and on silence, which covers everything that stops the tick itself: a broken
  deploy, an account problem, D1 down. The problems, and what to do:
  - *feeds more than two hours past due* (more than three, none of them held): the sweeps are
    not keeping up or not running. Check `ops_heartbeats` and the Worker's logs.
  - *jobs dead-lettered in the last day* (more than twenty): see *What gave up* above.
  - *body translations waiting over 30 minutes*: a reader is waiting. `select * from
    body_translations where state in ('requested', 'running')`; the provider may be down, or its
    key gone.
  - *articles waiting over six hours for their full text* (more than twenty): extraction is
    failing on some host; the dead letters name it.
  - *the last backup is from …* or *failed its check*: see *Backups*.
- **The Monday digest** to `DIGEST_TO`: new posts and members, failing and dead feeds, dead
  letters, model use, database size, the last backup, and feeds Cloudflare cannot reach (the case
  for the relay). Without `DIGEST_TO` or `RESEND_API_KEY` it is built and not sent;
  `wrangler tail tela-jobs` on a Monday at 08:00 UTC shows the run.
- **Resend's and Bailian's own consoles** for their quotas; the digest shows Tela's side of both.

## Backups

- **Time Travel** is the point-in-time copy: `wrangler d1 time-travel restore tela --timestamp=…`
  rolls the database back to any minute of the last 30 days. It restores in place; export first
  if the current state matters.
- **The nightly export** is the portable one. After the upkeep, every table worth keeping goes to
  `tela-content` under `backup/<date>/` as JSON lines (`<table>.<part>.jsonl`, 5,000 rows a part),
  with a `manifest.json` of row counts and SHA-256 hashes. A second pass reads it back to verify,
  and `backup/latest.json` records the result. Thirty days are kept. Sessions, sign-in codes,
  leases and limits are not exported: a restored database signs everyone in again.
- **Check one by hand:** `wrangler r2 object get tela-content/backup/latest.json --pipe --remote`.
- **The exit path off Cloudflare** (ADR 0021), which the suite runs on every commit
  (`apps/api/test/backup.test.ts`):
  1. Copy the bucket, backups included, to any S3-compatible store (`rclone` speaks both).
  2. Create a libSQL database (a file, or Turso), apply `packages/data/migrations`, and call
     `restoreDatabase` from `@tela/data` against the S3 copy (`s3Blobs` in
     `@tela/platform/portable`).
  3. Serve `createApp` (`apps/api/src/app.ts`) from any Hono runtime on `libsqlDb` and `s3Blobs`,
     run `runPortable` (`apps/jobs/src/portable.ts`) beside it for the sweeps, and serve the
     built SPA and `createEdge` (`apps/reader/worker/edge.ts`) in front. Every dependency is
     already an interface with a portable adapter.

## Curation

Discover has three doors (ADR 0018): the editorial list, a verified claim, and three distinct
subscribers on an unclaimed site.

- **Apply the editorial list:** `ADMIN_TOKEN=… bun run admin curate` adds each blog in
  `apps/api/scripts/curated-sites.ts` (fetched and parsed, so its declared home is honoured) and
  features it with its topics, one blog a request. Running it again changes nothing that is
  already right. A rejected blog is left alone; a claimed one keeps its owner's topics.
- **Feature or hide a blog by hand:** `update sites set listing = 'featured' where id = …`, or
  `'rejected'`, which curation then leaves alone.
- **Release a claim** so another member can claim the site: `update sites set claimed_by = null,
  claimed_at = null where id = …; delete from site_claims where site_id = …`.

## Translation

- **Spend:** `select * from usage_daily order by day desc limit 14` (subject `'*'` is background
  titles, anything else a member), and per call `select job, model, count(*), sum(input_tokens),
  sum(output_tokens) from llm_calls where created_at > … group by job, model`. The digest has the
  week's totals.
- **Budget:** `LLM_DAILY_BUDGET_TOKENS` stops the title sweep for the rest of the UTC day once
  spent. Reader requests still run, metered per member (30 requests an hour, a daily token
  allowance).
- **Retranslate titles:** `delete from article_titles where article_id in (…)`; the sweep finds
  them again. A title that is its own translation is recorded as `echo` and not retried.
- **A stuck body:** `select * from body_translations where state in ('requested', 'running')`. A
  row stays `running` between executions of one request and needs nothing; one that exhausted its
  attempts is `failed`, with its dead letter beside it. The block cache keeps what was
  translated, so a retry pays only for the rest.
- **Switch provider:** change `LLM_PROVIDER`, `LLM_MODEL` and the key, and deploy tela-jobs.
  Cached blocks keep their `model`, so old and new output can be compared.
- **Add a reading language:** append it to `READING_LANGUAGES` in `packages/shared`, add its name
  to `LANGUAGE_NAMES`, and a message catalog if it is also a UI locale.

## WebSub

- On with `WEBSUB_ENABLED=1` once `PUBLIC_URL` is the real origin.
- **State:** `select feed_id, status, lease_until, last_error from websub_subscriptions order by
  lease_until`. `failed` rows retry weekly, `pending` ones never verified retry daily, `active`
  leases renew two days before they end.
- **Force a resubscribe:** `delete from websub_subscriptions where feed_id = …`; the next fetch of
  that feed records the hub again.
- A ping only makes the feed due, so a misbehaving hub cannot inject content; a bad signature is
  a 403 in tela-api's logs.

## The relay

**When to provision it.** Not until a feed needs it: every production feed, Chinese blogs
included, fetched from Cloudflare in spike S2 and in the shadow run. Without `RELAY_URL` nothing
moves to the relay, but each feed still counts consecutive timeouts, and the digest lists the ones
at three or more: `select id, feed_url, timeout_streak, last_error from feeds where timeout_streak
>= 3`. A feed that stays there while the rest of the web answers (a mainland host Cloudflare
cannot reach) is the reason to run the box.

- **Deploy:** `docker build -f apps/relay/Dockerfile -t tela-relay .`, run it on a Hong Kong box
  with `RELAY_SECRET` (32+ random characters) behind TLS (Caddy, or the provider's load balancer),
  and check `GET /healthz`. Then set `RELAY_URL=https://relay.<domain>` and the same
  `RELAY_SECRET` on tela-jobs. The next timeouts move those feeds over on their own.
- **Which feeds use it:** `select id, feed_url, region_flipped_at, timeout_streak from feeds where
  fetch_region = 'cn'`. The nightly upkeep re-probes `cn` feeds directly after seven days; one
  that times out three more times flips back by itself.
- **Rotate the secret:** on the relay set `RELAY_SECRET_PREVIOUS` to the current value and
  `RELAY_SECRET` to the new one, restart; then set the new `RELAY_SECRET` on tela-jobs; finally
  remove `RELAY_SECRET_PREVIOUS` from the relay. Signatures expire after five minutes, so keep the
  box's clock in sync (NTP).
- **It is not an open proxy:** only signed `POST /fetch` requests are served, private ranges are
  refused, redirects are not followed, the upstream body is capped at 5 MB, and a request larger
  than 64 KiB is refused before it is read (the signature covers the body, so that cap is the only
  pre-authentication limit).

## Later

- **To open Tela up:** decide how invitations work first (ADR 0015); then remove
  `TELA_PRIVATE_BETA` from `apps/reader/wrangler.jsonc` and deploy tela-web.
- **The next Node LTS**, for the relay only, **after 2026-10-28**, when Node 26 reaches LTS; Node 24 <!-- node-pin:planned -->
  enters maintenance on 2026-10-20, so the two dates make one clean move. Five pins change <!-- node-pin:planned -->
  together: `.node-version`, `engines`, the relay Dockerfile's runtime stage, the CI
  `node-version` and `@types/node`, plus the Node major the living docs name. `test/docs.test.ts`
  fails until they all agree.
- **China checks** from a mainland connection once readers there are invited: the first sync, and
  images from hosts like `mmbiz.qpic.cn`.
