# Operations

How Tela is provisioned, deployed and kept running: three Cloudflare Workers, D1, R2 and Queues
(ADRs 0020–0027), at https://telaread.com. The old address, tela.ainaive.com, redirects there
through a fourth Worker (*The address*, ADR 0042).

## Environments

| Component | Where | Notes |
|---|---|---|
| tela-web | Worker at the reader's edge, unpinned (`apps/reader`) | The only public Worker: static SPA, public pages, `/o/*`, `/img/*`, the `/api/*` forward. Custom domain `telaread.com` only; `workers.dev` stays off (blocked in mainland China) |
| tela-api | Worker pinned to `aws:ap-southeast-1` (`apps/api`) | Sign-in, sync, mutations, every reader RPC. No public route: tela-web reaches it over a service binding |
| tela-jobs | Worker pinned to `aws:ap-southeast-1` (`apps/jobs`) | Crons, queue consumers, the `Ingest` RPC. No public route |
| tela-redirect | Worker, no bindings (`apps/reader/redirect`) | `tela.ainaive.com` and `www.telaread.com`: a redirect to the same path on telaread.com, and the shell's kill switch at `/sw.js` (*The address*) |
| D1 `tela` | Primary in Singapore (`--location apac`) | 6–10 ms from the pinned Workers; Time Travel keeps 30 days |
| R2 `tela-content` | Private | Content, translation and chunk objects (served by tela-web to members), raw item HTML, members' uploaded pictures (`avatars/`, served by tela-api at `/avatar/…`, ADR 0033), and the nightly `backup/`. The pictures are member data the D1 export does not hold: a move off Cloudflare copies `avatars/` too |
| R2 `tela-assets` | Public at `assets.telaread.com`, and still at `assets.tela.ainaive.com` | Favicons |
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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | tela-api (secret) | Tela's Google OAuth client (ADR 0036), a Web client whose redirect URI is `PUBLIC_URL/api/auth/callback/google`. Google sign-in is offered only while both are set |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | tela-api (secret) | Tela's GitHub OAuth app (ADR 0036), its callback URL `PUBLIC_URL/api/auth/callback/github`. GitHub sign-in is offered only while both are set |
| `MAIL_FROM` | tela-api, tela-jobs | Sender, `Tela <noreply@telaread.com>`, a domain Resend has verified (ainaive.com is verified too, and was the sender until 2026-10-08) |
| `PUBLIC_URL` | tela-api, tela-jobs | The one public origin, `https://telaread.com`: better-auth's base URL and trusted origin, claim `rel="me"` targets, the WebSub callback |
| `TELA_PRIVATE_BETA` | tela-web | `1`: robots.txt disallows everything and every response the Worker serves carries `X-Robots-Tag: noindex, nofollow` (ADR 0015). The SPA shell is a static asset the Worker never sees, so it is noindex by its own meta tag, always: it is the app, with nothing of its own to index. Public pages drop that tag and follow this var. `/` now passes the Worker (the front page, ADR 0035), so both of its answers, a visitor's page and a member's plain shell, carry the header too |
| `GRAVATAR_URL` | tela-api, tela-jobs | Where members' pictures are fetched from (tela-api, ADR 0032) and asked about (tela-jobs, ADR 0033), default `https://gravatar.com/avatar`. The e2e points it at its fixture server. A picture is cached for 30 days in each colo and browser under an address with its version, and turning the switch off cannot purge a colo: a copy already held stays, at an address nothing links to any more |
| `ENV` | tela-api, tela-jobs | `test` in local dev and e2e only: the sign-in outbox, `POST /api/test/cycle`, and fetches to private addresses. Never deployed |
| `WORKER_USER_AGENT` | tela-jobs | Sent on every fetch; keep a contact URL in it |
| `FETCH_TIMEOUT_MS` | tela-jobs, the relay | Per-request timeout, default 20000 |
| `WEBSUB_ENABLED` | tela-jobs | `1` subscribes at feeds' hubs; hubs verify by calling `PUBLIC_URL/api/websub/<feedId>` |
| `LLM_PROVIDER` | tela-jobs | `bailian` (default), `anthropic` or `mock`. Without the matching key the provider falls back to the mock, and the translation kinds are then disabled rather than caching placeholder output; set `mock` on purpose for local runs only |
| `LLM_MODEL` | tela-jobs | `glm-5.2` (Bailian default), `claude-opus-5` (Anthropic default) |
| `BAILIAN_API_KEY`, `BAILIAN_BASE_URL` | tela-jobs (key secret) | The key is a mainland one: leave the base URL unset (`dashscope.aliyuncs.com`; the international endpoint refuses it) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | tela-jobs (key secret) | Anthropic, if ever used |
| `LLM_JSON_MODE` | tela-jobs | `text` (parse JSON from the reply; Bailian's default) or `schema` (structured output; Anthropic's) |
| `LLM_DAILY_BUDGET_TOKENS` | tela-jobs | Day cap for background title translation; `0` = unlimited. Production sets 2,000,000 in `apps/jobs/wrangler.jsonc`, so every deploy carries it (until 2026-10-04 it was set nowhere, and titles ran uncapped). Reader requests are metered per member instead |
| `LLM_MAX_ARTICLE_TOKENS` | tela-jobs | Source tokens translated per body (default 40,000); the rest stays as source and the translation is `partial` |
| `LLM_MOCK_DROP_MARKER` | tela-jobs, tests only | With `LLM_PROVIDER=mock`, the mock drops every block containing this text, so a run can reach `partial` |
| `RELAY_URL`, `RELAY_SECRET` | tela-jobs (secret) | The relay's origin and shared signing secret. Unset (as now): feeds never change region |
| `RELAY_CONTROL_URL` | tela-jobs | Fetched before flipping a feed to the relay; if it fails too, the problem is Cloudflare's network, not the feed (default: Cloudflare's trace endpoint) |
| `RELAY_SECRET`, `RELAY_SECRET_PREVIOUS`, `RELAY_PORT` | the relay | Accepted secrets (the previous one during rotation) and the listen port (8787) |
| `DEADMAN_URL` | tela-jobs (secret) | The healthchecks.io ping URL; see *Knowing it runs* |
| `DIGEST_TO` | tela-jobs (secret) | Who gets the Monday digest (the owner). Unset, it is built but not sent |
| `VITE_ASSETS_URL` | tela-web build | Public base of `tela-assets`; defaults to `https://assets.telaread.com` |
| `TELA_URL` | the admin script | Where `bun run admin` talks to; defaults to `https://telaread.com` |

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
   already exists, public at `assets.telaread.com` (an R2 custom domain) and at
   `assets.tela.ainaive.com`.
3. **Queues:** `wrangler queues create tela-fetch`, and the same for `tela-extract`,
   `tela-translate`, `tela-misc` and the alarm-only `tela-dlq`.
4. **Schema:** `cd apps/api && wrangler d1 migrations apply tela --remote`. The files are
   `packages/data/migrations`, the SQL the tests apply on libSQL and in workerd. New ones come from
   `bun run db:generate`; review the SQL and commit it.
5. **Secrets:** `AUTH_SECRET` on tela-api and tela-web (the same value); `ADMIN_TOKEN` and
   `RESEND_API_KEY` on tela-api; `BAILIAN_API_KEY`, `RESEND_API_KEY`, `DIGEST_TO` and `DEADMAN_URL`
   on tela-jobs. Google and GitHub sign-in stay off until their two secrets each are set on
   tela-api (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`).
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
      telaread.com itself.
   4. `cd apps/reader/redirect && wrangler deploy -c wrangler.jsonc`: tela-redirect, which holds
      the old address and `www` (*The address*). It changes rarely; deploy it only when it does.

   **A release that bumps `MIN_CLIENT` reverses the last two:** tela-web first, then tela-api
   within minutes. A shell on the new protocol still works against the old tela-api, but the new
   tela-api tells every older shell to upgrade, and one whose reload finds no newer shell to load
   stalls until it is navigated. So the newer shell must already be live.

   Rolling back:
   - tela-api may go back alone, but the old API does not check which account a request is for,
     so while it is live a stale tab can again act for the account another tab signed into.
     Keep it short, or take tela-web back with it.
   - tela-web may not go back while the new tela-api is live: every restored older shell would
     be told to upgrade and find no newer shell to load.
   - Follows (ADR 0031, migration 0002) are additive and keep protocol 2: apply the migration
     before deploying tela-api.
     - **tela-api may go back alone.** Shells keep syncing: a pull without `follows` reads as
       having none, and a profile row without `publicLikes` keeps the device's value. The
       older API refuses `follow`, `unfollow` and `setPrivacy` as invalid, so those buttons and
       switches visibly go back; the Following page and "Your data" answer 404; public profiles
       and blog pages render without counts, notes or Follow. A device that took a snapshot
       meanwhile holds no follows until the followee's profile next changes or it starts over
       (a sign-in), since the older API never sent them, and one that had no profile row before
       shows its likes switch off until the member's profile next changes.
     - **tela-web must not go back past this release.** The shell before it has no case for a
       follow in its reducer: a device holding an unsent `follow`, `unfollow` or `setPrivacy`
       (made offline, or pushed as the tab closed) boots blank under it, and stays blank until
       tela-web rolls forward or the browser's site data is cleared. This release's reducer
       ignores types it does not know, so rolling back *to* it from a later one is safe.
   - Gravatar pictures (ADR 0032, migration 0003) are additive and keep protocol 2: apply the
     migration before deploying tela-api, and deploy tela-api before tela-web.
     - **Either Worker may go back alone.** An older tela-api refuses `setAvatar` as invalid, so
       the switch visibly goes back; its profile rows carry no picture, and a device keeps the
       one it held; `/avatar/…` answers 404, which shows the letter. An older tela-web (not
       before the follows release) ignores an unsent `setAvatar` in its reducer.
   - Uploaded pictures and Gravatar on by default (ADR 0033, migration 0004) are additive and keep
     protocol 2: apply the migration, then deploy tela-jobs (the `member.gravatar` kind), tela-api,
     tela-web.
     - **Any Worker may go back alone.** Without the new tela-jobs nobody's Gravatar is checked,
       so a member with no upload shows their letter. An older tela-api has no `/api/v1/avatar`
       (Settings' upload fails visibly) and serves only Gravatars at `/avatar/…`; uploaded objects
       stay in R2 for when it returns. An older tela-web shows no upload controls.
   - Invite codes (ADR 0034, migration 0005): apply the migration, then deploy tela-jobs,
     tela-api, tela-web. tela-jobs needs the new tables before its next cron: the daily batch
     prunes lapsed holds and the nightly export reads both tables, so without them the whole
     batch fails at 03:17, and that night's export with it. **tela-api needs them before it
     serves:** its gate claims an invitation for every new account, the operator's `admin invite`
     included, and `/api/v1/join`, `/api/v1/invites` and `/api/admin/codes` read and write them,
     so a tela-api deployed first answers each of those 500 until the migration lands.
     - **tela-jobs may go back alone.** The older one neither prunes holds nor exports the two
       tables.
     - **tela-api may go back alone.** The older one makes no account at a code sign-in, so a
       joiner's code is refused until it returns, and `/api/v1/join` and `/api/v1/invites` answer
       401 or 404. Codes, holds and redemptions wait in their tables, and a hold still lapses
       after its day.
   - The front door (ADRs 0035, 0036) ships with the invite codes, so it goes in the same order:
     migration 0005 applied, then tela-jobs, tela-api, tela-web. tela-api must be live before
     tela-web, or `/` finds no `/api/v1/public/front` and shows visitors the plain shell (never
     cached, so it heals once tela-api is out). tela-web's service worker moves to `SHELL` v3 in
     the same build that puts `/` in `run_worker_first`: one deploy, never one without the other,
     since a v2 worker takes its shell from `/`, which the edge now renders for visitors. Then
     check one browser (below, *The app shell*).
   - The language circle, the Discover review and mark as unread (ADRs 0040, 0041, migration
     0007) are additive and keep protocol 2, with no `MIN_CLIENT` bump. Before applying, note
     the Time Travel bookmark (`wrangler d1 time-travel info tela`) and count what the backfill
     will touch: `select reading_lang = ui_locale, count(*) from profiles group by 1` and
     `select listing, claimed_by is null, count(*) from sites group by 1, 2`. Then apply the
     migration and deploy tela-jobs, tela-api, tela-web:
     - tela-jobs first, because its nightly compaction must keep rows marked unread before any
       exists, and its digest reads `sites.review`.
     - tela-api before tela-web, because the new shell sends `readingLang: null`, `adopt`,
       `ifAbsent`, `base` and `markUnread`, which an older tela-api refuses, or strips and applies
       unconditionally (`adopt`, `ifAbsent`). The console's new `dismissed` filter would answer
       400 from an older tela-api.
     - **Any Worker may go back alone.** An older tela-web ignores the new fields and shows a post
       marked unread below its feed's watermark as read. An older tela-api refuses the new
       mutations visibly, takes a show without its `base` by `at` again, and returns public
       reader counts below three. An older tela-jobs's compaction drops marked-unread rows under
       the watermark, so those posts read as read again.
     - The migration is additive. Its two backfills are undone only by Time Travel, which loses
       every write since: `reading_lang` cleared where it equalled `ui_locale` (an older shell
       reads null the same way), and `sites.review` set from each blog's listing.
     - After deploy, check that:
       - the circle shows in both headers and on `/login`;
       - a linked choice on one device changes both languages on another;
       - `/admin/discover` opens on To review;
       - `/discover` shows no count below three;
       - `curl -sI https://telaread.com/manifest.webmanifest` is `application/manifest+json`;
       - a code requested from a French browser arrives in French.
   - Protocol 2 (2026-09-29) keeps each device's copy in IndexedDB `tela-2`; earlier shells use
     `tela`, which the newer shell empties at each boot and marks as seen. A tela-web rollback
     leaves the `tela-2` copies in place, and the older shell starts over in `tela`. On the way
     forward again the newer shell sees that an earlier build touched `tela` (wrote to it, or
     cleared it on a sign-out, which takes the mark) and marks its own copy unverified: every tab
     asks who is signed in before trusting it, tabs booting together included, until the claim
     after that answer. Browsers without `indexedDB.databases()` (Firefox before 126) cannot see
     this, and trust their copy until its first request is refused.
   - While tela-api is down or deploying, a tab that has to ask who is signed in gets no
     answer. At a boot (the one after a rollback, say) it shows the public side, sends member
     pages to `/login`, and keeps its copy and unsent changes. After a sign-in the login page
     says it is signed in and connecting, and a tab that was already a member stays one until
     the answer comes. Either way it asks again by itself, within 2 minutes of tela-api
     answering, and carries on where it was; if the answer is another account than the page
     showed, as a fresh page. Only a 401 forgets the copy.

   Protocol 2 also starts every device over once, at its first boot on the new shell: it waits
   on the network that one time, and any unsent change the old shell left behind is dropped. Its
   failure signature is visible and intended: a tab jumps to `/` when another tab of the same
   browser signs in as someone else, on its next call to tela-api.

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

## The address

Tela is served from `https://telaread.com`, the apex, by tela-web (ADR 0042). Two hosts only
redirect there, through tela-redirect (`apps/reader/redirect`, no bindings): the old address
`tela.ainaive.com` and `www.telaread.com`. Every request goes to the same path and query on
telaread.com, 301 (308 for a write). `/sw.js` alone is answered 200 with the shell's kill switch,
which retires the service worker a browser kept from the old address: that worker answers every
navigation from its cache, so without the kill switch it would never see a redirect. Never make
`/sw.js` a redirect, either: the browser refuses a redirected worker script and keeps the old one.
Keep tela-redirect on the old address for as long as `ainaive.com` is held.

- **Logs** show which old paths are still visited, never their query strings
  (`redact_query_string`): `/join?code=…` and the mail's `/login?…&otp=…` carry codes there.
  Keep it on. `wrangler tail` is live and may show the full URL; tail it only when you must.
- **Deploy:** `cd apps/reader/redirect && wrangler deploy -c wrangler.jsonc`. Without `-c`, wrangler
  also finds the deploy config `vite build` leaves in `apps/reader` and refuses to choose.
- **A custom domain belongs to one Worker.** A deploy sets its Worker's domains to the list in its
  config: it takes over a listed domain from whichever Worker holds it (a deploy without a TTY does
  so without asking) and releases any it no longer lists. So tela.ainaive.com never goes back into
  tela-web's `routes` unless it is a rollback.
- **Favicons** are at `assets.telaread.com`, an R2 custom domain on `tela-assets`.
  `assets.tela.ainaive.com` stays attached to the same bucket.
- **Check:** `curl -sI 'https://tela.ainaive.com/@hutusi?tab=liked'` is a 301 to
  `https://telaread.com/@hutusi?tab=liked`, and `curl -s https://tela.ainaive.com/sw.js` is the kill
  switch (it calls `registration.unregister()`).

**The move, once:**

1. In the telaread.com zone: Always Use HTTPS on, and the minimum TLS version ainaive.com uses.
   Nothing may sit on `@`, `www` or `assets` in its DNS: a Worker deploy or an R2 domain
   overwrites a record there.
2. `wrangler r2 bucket domain add tela-assets --domain assets.telaread.com --zone-id <zone id>`
   (or R2 → tela-assets → Settings → Custom Domains). A favicon key must answer 200 there before
   tela-web deploys, since the new build asks for favicons there.
3. Open Tela on every device, online, so nothing is left unsent. Cookies and IndexedDB belong to
   an origin: the copy on the old address is never read again, and every member signs in afresh
   on telaread.com, each device starting over.
4. Deploy, one at a time: tela-jobs, tela-api, tela-web, tela-redirect. Two short gaps are
   expected:
   - tela-web's deploy releases tela.ainaive.com, which is dark until tela-redirect's deploy
     takes it, about a minute later;
   - from the tela-api deploy until tela-web's, a sign-in on either host fails the origin check,
     since better-auth trusts only `PUBLIC_URL`.
5. Check:
   - `https://telaread.com/` is 200 with `x-robots-tag: noindex`; `/api/health` answers `ok` and
     `/api/v1/me` 401 signed out; `http://telaread.com/` redirects to https;
   - the two redirects above, and `https://www.telaread.com/discover`;
   - a favicon from assets.telaread.com;
   - a code sign-in, whose mail links to telaread.com;
   - one browser that had the old worker: reopening `tela.ainaive.com/reading` ends at
     `telaread.com/reading`, and DevTools → Application shows no service worker and no
     `tela-shell-v3` cache left for tela.ainaive.com.
6. **Rollback:** revert the move's commit and deploy tela-api and tela-web from it. tela-web
   takes tela.ainaive.com back from tela-redirect and releases telaread.com. A browser that took
   the kill switch registers the shell worker again on its next visit. Then remove
   `www.telaread.com` from tela-redirect (Workers → tela-redirect → Domains), since it would
   redirect to a dark host.

**Mail followed on 2026-10-08.** `telaread.com` is verified in Resend, and `MAIL_FROM` is
`Tela <noreply@telaread.com>` on both Workers. A sending key restricted to one domain cannot send
from another: if `RESEND_API_KEY` is ever replaced, it must be allowed to send from telaread.com,
or every code request fails, Resend refusing the sender. Going back is the old `MAIL_FROM`
(ainaive.com stays verified) and a deploy of tela-jobs and tela-api.

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
1. Invite: `TELA_URL=http://localhost:5173 ADMIN_TOKEN=local bun run admin invite you@x.test`, or
   make a code to join with: `TELA_URL=http://localhost:5173 ADMIN_TOKEN=local bun run admin code
   TEST --uses 2`.
2. Sign in at `/login`, reading the code from `/api/test/outbox?email=you@x.test`.
3. Add a feed on `/add`. The crons do not fire in dev: `curl -X POST -H 'origin:
   http://localhost:5173' localhost:5173/api/test/cycle` runs the sweeps to completion (fetches,
   extraction, titles, claims), which is what the minute tick does in production.

**Something to look at:** with `bun run dev` running, `bun run dev:seed you@example.com` adds the
curated blogs and runs the sweeps so they have posts, then writes made-up members, codes, claims
to review, feeds in trouble, a month of translation spend and dead letters into the local D1, so
every area of the admin console (ADR 0039) has something in it. It invites the address, opens the
console to it, and prints its sign-in link. It writes the made-up states once (a second run only
adds what is missing), and only ever with `wrangler d1 execute --local`: it refuses any
`TELA_URL` that is not localhost. Without an address, its own Mara is the admin it names.

To try Google or GitHub, register a dev OAuth app with the callback
`http://localhost:5173/api/auth/callback/google` (or `/github`) and add its `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` (or `GITHUB_…`) to `apps/api/.dev.vars`; join with a code from `admin code`.

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
- **Service workers are blocked**, so every spec measures the app, not a cached shell. The one
  exception is the `shell-worker` project, `redirect.e2e.ts`: on two local origins of its own it
  installs the real `public/sw.js`, then answers as tela-redirect, and checks that a redirect
  rule alone leaves the old shell painting while the kill switch at `/sw.js` takes both open tabs
  to the new origin and leaves nothing behind (ADR 0042).
- **Logs:** `.e2e-logs/reader/{build,workers,fixtures}.log`; traces in `apps/reader/test-results`.
- First run: `cd apps/reader && bunx playwright install chromium`.

## tela-web

`apps/reader/wrangler.jsonc`. No D1 binding: `BLOBS` is `tela-content` (read-only here) and `API`
is tela-api.

- **Images:** `/img/<contentKey>/<i>` fetches only what a content object names, over
  `global_fetch_strictly_public`. A broken image is the origin's answer, which the Worker logs
  show; nothing is signed, so there is no secret to rotate.
- **Public pages** (the front page `/`, Discover, `/s/:id`, `/@handle`) are rendered here and
  kept in each colo's cache for five minutes, keyed by locale and by the build. So a deploy never
  serves a page that names scripts it removed, and a blog's change shows within five minutes.
  There is nothing to purge. `/` is rendered only for a request without `tela.session_token`; a
  member's is the plain shell. If `/` shows the plain shell to signed-out visitors, tela-api's
  `/api/v1/public/front` is not answering 200 within three seconds (deploy tela-api before
  tela-web when it is new): tela-web logs `public page data late` or `public page data failed`
  with the endpoint, which says which.
- **Writes to `/api/*` without this origin get 403** `cross-origin write refused`. Hubs
  (`/api/websub/*`) and the admin script (`/api/admin/*`) are exempt. A browser always sends
  `Origin` on a POST, so seeing this from the app means something is proxying it.
- **The app shell** is cached by a service worker (`public/sw.js`), for fast repeat visits. It
  fetches the shell from `/__tela/shell`, which tela-web never runs for, so the single-page
  fallback answers it with `index.html`; it keeps it under `/`. Keep `/*` and `/__tela/*` out of
  `run_worker_first` (ADR 0035). If a bad shell ships and a fix does not reach readers, because
  their cached shell never asks, use the kill switch:
  1. `cp apps/reader/shell/kill-sw.js apps/reader/public/sw.js`, then build and deploy.
  2. On their next visit, browsers install it. It drops every cached shell, unregisters itself,
     and reloads open tabs from the network.
  3. Restore `public/sw.js` with the next deploy.

  A shell older than the sync protocol clears itself anyway: tela-api answers it 409 `upgrade`.

  Bump `SHELL` in `public/sw.js` (`tela-shell-v3` now) whenever a released worker may have cached
  something wrong. The new worker's activation deletes every other cache and warms its own from
  the network, holding the open tabs' requests until it has, for at most 3 s (`WARM_MS`); if the
  warm fails, the first navigation goes to the network like a first visit. v2 exists because v1 could keep `index.html`
  under a script's name: a blank page after a deploy, and in the console "Expected a
  JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"" for
  `/assets/index-*.js`. v3 exists because v2 took its shell from `/`, which the edge renders for
  visitors (ADR 0035): in the minutes between the deploy and a browser installing v3, a v2
  worker could keep the landing, with its `#tela-data`, and paint it on every page. v3's
  activation drops it.
  A cached shell changes only once every file it loads is cached, and only to the plain shell
  (an empty `#root`, no `#tela-data`, not reached by a redirect), so a refresh that cannot get
  one (the network gone halfway, a proxy's or a captive portal's page, a rendered page) leaves
  readers on the shell before, and the next navigation tries again.

  **After a deploy that changes the shell**, check one browser that had the old worker: open
  telaread.com, then DevTools → Application → Service workers shows the new one activated,
  and Cache Storage → `tela-shell-v3` → `/` is the plain shell: its body has an empty
  `<div id="root"></div>` and no `tela-data`. A `/` holding `tela-data` is a rendered page kept as
  the shell, which would paint the front page over every screen: bump `SHELL` and deploy again.

## tela-api

`apps/api/wrangler.jsonc`: sign-in, sync, mutations and every reader RPC (ADR 0024). It shares the
D1 database and `tela-content` with tela-jobs, and only produces to the jobs queues.

- **Invite a member:** `ADMIN_TOKEN=… bun run admin invite reader@example.com`. It writes the
  operator's invitation to the address, creates the account and its profile through the same gate
  as every other (ADR 0034), and mails a code that says the address is invited; inviting an
  existing address only mails a fresh code. No account is made without an invitation.
- **Invite codes** (ADR 0034). Every member may invite five people, ever, from Settings → Invites
  (`/api/v1/invites`): a code counts while unrevoked and for good once used, and revoking an
  unused one frees its place. The operator's codes are their own text:
  - `ADMIN_TOKEN=… bun run admin code WELCOME --uses 20` makes one for twenty people (one when
    `--uses` is left out; up to 100,000) and prints its link, `/join?code=WELCOME`. The text is
    normalized like any code typed in (capitals, no spaces or dashes, 4–32 letters and digits),
    and may not be twelve of a member code's symbols, which is how a code says whose it is. A word
    is guessable: keep `--uses` small, and revoke it when its moment has passed.
  - `bun run admin codes` lists them: places taken of places given, live holds, when it was made
    and revoked.
  - `bun run admin revoke WELCOME` withdraws one, used or not: nobody else joins with it, its
    holds are cancelled, and those who joined keep their accounts.
  - A join (`POST /api/v1/join`) holds the address beside the code for a day and mails a code that
    says it is invited. The hold takes no place; signing in takes one. On a single-use code a
    later join moves the hold to the later address. `400 invalid_code` is a code that is unknown
    or revoked, `409 code_used` one whose places are all taken, by a newcomer or a member alike.
    An address that has an account gets a plain sign-in code, and the code is untouched.
  - What a code holds: `select * from invite_redemptions where code = '<CODE>'` (no `redeemed_at`:
    a hold; `redeemed_at`: a place; `settled_at`, `user_id`: the account it made), and who made
    it: `select created_by, max_uses, revoked_at from invite_codes where code = '<CODE>'`.
- **Google and GitHub apps** (ADR 0036). Register one app per provider for production and a
  separate one for development, so a dev secret never signs anything in on telaread.com:
  - **Google** (Google Cloud console → APIs & Services): the OAuth consent screen as *External*,
    with the app name, the support address, the privacy policy URL
    `https://telaread.com/privacy`, and `telaread.com` among the authorized domains; scopes
    `openid` and `email` only. Then **publish it to production**: while it is in *Testing* only
    the listed test users can sign in. The credential is a *Web application* client whose
    authorized redirect URI is `https://telaread.com/api/auth/callback/google`, nothing else.
  - **GitHub** (Settings → Developer settings → OAuth Apps): homepage `https://telaread.com`,
    authorization callback URL `https://telaread.com/api/auth/callback/github`.
  - **Development:** the same, with `http://localhost:5173/api/auth/callback/google` (or
    `/github`) as the redirect URI, in `apps/api/.dev.vars` (see *Running locally*).
  - **Secrets**, on tela-api: `cd apps/api`, then `wrangler secret put GOOGLE_CLIENT_ID`,
    `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. A provider is offered
    once both of its secrets are set, and gone again when either is deleted. Each `secret put`
    deploys a new version of tela-api, which uses it from then on.
  - **Failure signatures:**
    - `redirect_uri_mismatch` (Google), or GitHub's "The redirect_uri is not associated with this
      application": the provider's own error page, so nothing comes back to Tela and nothing is
      in its logs. The app's redirect URI is not exactly `PUBLIC_URL/api/auth/callback/<id>`.
    - `?error=invalid_code` on the page a provider sign-in started from (`/login?…&via=github&
      error=invalid_code`, say), and the sheet says it could not reach the provider: better-auth
      could not exchange the provider's code for a token, so the client secret is wrong, rotated
      at the provider and not here, or belongs to the other app. It is not an invite code (that
      one is refused before the visitor leaves, as `400 INVALID_CODE`).
    - Runs of `state_mismatch` (or `state_not_found`): returns without the state cookie or its
      row: the provider took more than ten minutes, the browser drops the cookie, or the return
      was replayed. One now and then is a visitor who walked away; many in a row from different
      people point at the cookie (`advanced.cookies.state`) or `PUBLIC_URL`.
    - `account_not_linked`: a member pressed a provider they have not linked (they log in by
      email and link it in Settings → Account), or a newcomer's provider address is unverified.
      One answer for both, on purpose.
- **A mail's language** (ADRs 0013 and 0038, amended): every mail is in one of the four
  languages with English beside it, and an English one is English then Simplified. A code mail
  (sign-in, invitation, reset) follows the `tela_locale` cookie of the browser that asked, then the
  account's `profiles.ui_locale`, then its Accept-Language, then English; a join passes only that
  cookie and Accept-Language on to better-auth. A notice about an account's ways in follows
  `ui_locale` alone, else English. A member who got the wrong one: their browser's `tela_locale`
  cookie wins, then `select p.ui_locale from profiles p join user u on u.id = p.user_id where
  u.email = '<address>'`. The words are `apps/api/src/mail-text/*.json`; `zh-Hant.json` is
  regenerated by `bun run i18n:hant`, never edited.
- **Sign-in trouble:**
  - Codes last an hour and allow three attempts. A code tried three times, or past its hour, is
    answered `400 INVALID_OTP` like any wrong code (ADR 0036), so the answer never says the
    address holds one: the member asks for a new code either way. The sign-in endpoint allows three tries a
    minute per IP; past that the login page says "Too many tries", not "wrong code".
  - Each email address, from however many IPs, is also mailed at most five codes an hour and has
    at most ten guesses checked (`otpSend`, `otpVerify`), whatever the codes are for: sign-in,
    password reset and the address check share both counts, and so do all the endpoints that send
    or check one (`PER_ADDRESS` in `apps/api/src/auth.ts`) and a join with an invite code, which
    counts `otpSend` itself (`apps/api/src/routes/invites.ts`). The 429 is the same whether or
    not the address has an account. A member who sees "Too many tries" on their first attempt is
    most likely someone else asking for their address; it clears on the hour, or at once (the
    address lowercased) with
    `delete from action_limits where key in ('otpSend:<address>', 'otpVerify:<address>')`.
    The operator's `admin invite` is not counted.
  - Passwords (ADR 0036) are tried at `/api/auth/sign-in/email`: five tries a minute per IP
    (better-auth's `customRules`), and ten in fifteen minutes per address from anywhere
    (`passwordSignIn`), counted and refused like the code counts, which they never touch: an
    address locked out of its password still signs in by code. Clear it early with
    `delete from action_limits where key = 'passwordSignIn:<address>'`.
  - `401 INVALID_EMAIL_OR_PASSWORD` is the one answer for an unknown address, an account with no
    password and a wrong one. The sheet opens on the password (ADR 0043), so a member who never
    set one is told to choose *Email me a code instead*. A member who never set a password, or
    forgot it, can instead ask for a reset
    code (`/api/auth/email-otp/request-password-reset`): a mail `Reset your Tela password`, its
    link `/login?reset=1&…`, to an address that has an account and nothing to any other, from the
    same five sends an hour as the sign-in codes. The reset sets the password, adding one if there was none, and ends every
    session the member had; the five-minute signed copy keeps one alive elsewhere until it runs
    out. A password is never set at sign-up (`/sign-up/email` is closed).
  - Joining by email chooses a password (ADR 0043): the join's code step asks for it, and a first
    sign-in's mail (an invitation) links to `/login?…&join=1`, which asks for it before signing in.
    The form requires it, not the server: it is saved after the code's sign-in, so a joiner whose
    save failed, or who signed in with a fresh code from the Log in form, is in without one and
    adds it in Settings → Account or with *Forgot password?*.
  - `select key, count, last_request from rate_limit` shows better-auth's windows, and
    `select * from action_limits where key like 'otp%' or key like 'password%'` Tela's.
  - A code that never arrives: check Resend's log for the address first, then the Worker's logs
    for the send error. An address with no account is mailed only while it holds an invitation
    (a hold from a join lasts a day); otherwise the request answers as usual and nothing is sent.
  - A code sign-in refused `403 INVITE_REQUIRED` found no invitation for the address: it never had
    one, its hold lapsed or went with its revoked code, or a later join moved a single-use code's
    hold to another address.
    `INVITE_USED` means its hold is on a code that others filled after its code was mailed.
    `select * from invite_redemptions where email = '<address>'` shows what it holds.
  - **Google and GitHub** (ADR 0036) are offered once both of a provider's secrets are set, which
    `GET /api/v1/public/auth` reports. An account is made only with the invite code the sign-in
    started with: it is checked at the start (`400 INVALID_CODE`, `409 INVITE_USED`, counted with
    joins, below), rides in the OAuth state row (a `verification` row, ten minutes), and is claimed
    at the return. A return that signs nobody in redirects to the page it started from with
    `?error=`: `invite_required` (no code), `invite_unavailable` (the code filled up or was
    withdrawn meanwhile), `account_not_linked` (a member who has not linked that provider, which is
    done only from Settings, or an address the provider has not verified: one answer for both),
    `state_mismatch` (it came back without its cookie, after ten minutes, or twice). An account a
    provider made mails its address a notice (`provider notice not sent` in the logs if it fails).
    No token, name or picture is kept: the `account` row's token columns stay null.
  - A member whose `/api/v1/me` has `profile: null`, or whose invitation is redeemed but not
    settled, is repaired at their next sign-in. The Worker logs `invitation not settled` or
    `member not repaired` when writing either failed.
  - **Settings → Account** (`/api/v1/account`, ADR 0036) reads the session from D1 at every call.
    `403 session_not_fresh` is a session made more than a day ago, asked to add a way in or take
    one away: the member signs in again, by code or password, and tries from that session.
    Setting or changing a password, or linking a provider, ends every other session the member
    has; each change, and a reset by code, mails the member a notice (`account notice not sent` or
    `sessions not ended` in the logs when either fails; neither undoes the change). A link that
    fails comes back to `/settings?error=<code>`, better-auth's: `account_already_linked_to_different_user`
    for a provider identity another member has linked, `unable_to_link_account` for an address the
    provider has not verified, or for a browser that no longer holds a live session of the
    member's when the provider sends it back (it was signed out meanwhile, or signed in as someone
    else): nothing is written, and the member links again from a live session.
  - `404 {"error":"not_found"}` from a `/api/auth/*` path is tela-api, not better-auth: only the
    endpoints in `AUTH_ENDPOINTS` (`apps/api/src/app.ts`) and the sign-out are served (ADR 0036).
    A better-auth feature turned on later answers 404 until its endpoint is added there.
- **Sessions** last 60 days. A signed copy is trusted for five minutes, so a signed-out session
  can linger that long on a device that kept the cookie, everywhere but `/api/v1/account`, which
  reads D1. "Sign out everywhere" in Settings → Account ends every session but the member's own;
  an operator ends all of a member's with `delete from session where user_id = '<user id>'`.
- **Password hashing** is better-auth's scrypt (N=16384, r=16), native `node:crypto` under workerd:
  every password sign-in, reset or new password is one hash of about 32 MiB that blocks the
  isolate while it runs, and an unknown address is hashed too. Read its CPU time for
  `/api/auth/sign-in/email` in the Worker's logs after the first deploy that serves passwords; if
  it is too dear, the fallback is a `node:crypto` scrypt with r=8 behind a versioned prefix
  (ADR 0036).
- **Rate limits** on reader actions are `ACTION_LIMITS` (`packages/data/src/queries/limits.ts`):
  discover 30/h, subscribe 120/h, OPML import 5/h, claim start 10/h, claim verify 30/h, translate
  30/h, data export 10/h, new invite codes 20/h; a password set or changed 5 per 15 minutes,
  provider links and unlinks 10/h each (`passwordChange`, `accountLink`, `accountUnlink`: tela-api
  calls better-auth for these itself, which its limiter never counts). Lift a member's early: `delete from action_limits where key like 'discover:<user id>%'`.
  Sign-in has better-auth's per-IP limits (password sign-ins 5/min) and three of Tela's per email
  address, counted for any address in a `hooks.before` (`apps/api/src/auth.ts`): on every
  endpoint that sends or checks a code, code sends 5/h and code tries 10/h; on the password
  sign-in, tries 10 per 15 minutes.
  Joins with an invite code mail through tela-api's own call to better-auth, which its limiter
  never counts, so `/api/v1/join` counts its own, in this order, and stops at the first that is
  spent: per IP 10/h (`joinIp:<ip>`, an IPv6 address by its /64), counted before the code is
  looked up; then, only for a code that exists and is not revoked, per address 3/h
  (`joinAddress:<address>`) and its codes mailed with the sign-in ones (`otpSend:<address>`, 5/h),
  then per code (`joinCode:<CODE>`), as many an hour as the code has places and never fewer
  than 20. Each answers the same `429 rate_limited`. So junk spends no address's or code's hour,
  nor a word's before it is made a code, and no one client can spend a code's: that takes two at
  least, and one for every ten places a large code has. Many clients can (an IPv6 /56 is 256 of
  them): a public code refused hour after hour, with `joinCode:<CODE>` at its limit and holds from
  addresses that never sign in, is being held shut; revoke it and post another. A visitor told
  "too many tries" at their first join is most likely sharing an address, or an IP (a venue's
  wifi), with someone who tried before. Lift one early:
  `delete from action_limits where key = 'joinCode:WELCOME'`.
  A Google or GitHub sign-in that starts with an invite code spends the same per-IP and per-code
  counts (answered with better-auth's 429): checking its code there is a guess like a join's, and
  better-auth's own limit on `/api/auth/sign-in/social`, three every ten seconds per IP, would
  allow a thousand an hour.
  The handle check (`GET /api/v1/public/handles/:handle`, For writers' card) is counted per IP,
  300/h (`handleCheck:<ip>`), only for a handle of a valid shape; it answers `429 rate_limited`
  with `retry-after`.

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
| `member.gravatar` | a member shows their Gravatar and it was never asked about, or the answer has run out: 30 days after a picture, 7 after none (ADR 0033). Refresh asks again at once |
| `site.claim` | a member asked for their claim to be checked |
| `websub.subscribe` | a hub subscription is new, failed, or near its lease's end |
| `translate.title` | a feed has articles without titles in every launch language |
| `translate.body` | a member asked for a post in their language |

**Day 2, all plain SQL** (`wrangler d1 execute tela --remote --command "…"`):

- **What is held right now:** `select kind, key, owner, until, attempts, last_error from leases`.
  A row with `until = 0` is backing off until `not_before`. An owner of the form
  `<claim>><run>` (`translate.body:mumisiw0:ji73sz>n4wdspj4`) is a run that started; a bare claim
  owner is still waiting in its queue. A `lost` outcome for a key that finished is a duplicate
  delivery: queues deliver at least once, and the second copy found the claim already started.
- **A feed that ships excerpts but was learned as full:** its posts stop after a paragraph, and
  nothing extracts them. A feed's `content_mode` is learned once, at its first fetch, and a
  `full` feed's posts keep their feed version even beside an extraction. So a feed misread
  before the jump-link and read-more rules caught its shape stays wrong until it is set by hand:
  `update feeds set content_mode = 'summary' where id = …`, then queue its posts, as for a dead
  letter: `update articles set extract_state = 'due' where feed_id = …`. Each extraction stamps
  its article's seq when it lands, which is when devices get the full text.
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
  not null`. A merge moves readers and the posts only the alias had (with their titles,
  translations and read states), and deletes nothing. To undo
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
- **The Monday digest** to `DIGEST_TO`: new posts and members, how many blogs members added wait
  for review in Discover (with the link to `/admin/discover`, from `PUBLIC_URL`), failing and dead
  feeds, dead letters, model use, database size, the last backup, and feeds Cloudflare cannot
  reach (the case for the relay). Without `DIGEST_TO` or `RESEND_API_KEY` it is built and not sent;
  `wrangler tail tela-jobs` on a Monday at 08:00 UTC shows the run.
- **Resend's and Bailian's own consoles** for their quotas; the digest shows Tela's side of both.

## The admin console

`/admin` (ADR 0039) is where the operator acts on what the digest and the dead-man's switch
report: claims to review, feeds to fetch, pause or move to the relay, the blogs members added and
Discover's listings, members, invite codes, translation spend and dead letters. It reads from
tela-api over the network, unlike the rest of the reader, and every change it makes is audited in
`admin_actions`.

- **Open it to a member:** `ADMIN_TOKEN=… bun run admin grant you@example.com` (and `ungrant`). The
  account must exist; only the token grants it, so an admin cannot make another admin. The account
  menu shows *Admin* once the member's device has synced, and every console call reads the flag
  from D1 again, so an ungrant closes the console at once.
- **Undo** takes back a change that set a value (a listing, a pause, a region, a dismissal, a
  revoke) while nothing else has changed it since; otherwise it says so and restores nothing. A
  fetch, a check or a retry has no undo.
- **What it changes beats the work in flight.** Pausing a feed, moving it to the relay, rejecting or
  removing a claim break the item's lease in the same batch, so a job already running writes
  nothing over the choice.
- **Discover** opens on To review, the blogs members added that wait for a decision (ADR 0041),
  and badges how many there are; see *Curation*. A listing change reaches the public pages within
  about five minutes: the edge caches them per colo, and nothing purges that cache.
- **Sign out everywhere** deletes the member's sessions; a device's signed copy of one still
  answers for up to five minutes wherever only that copy is read.
- **Retry** on a dead letter makes its row due again for the next tick, with fresh attempts. A body
  translation retried runs as background work: the background budget pays, up to
  `LLM_MAX_ARTICLE_TOKENS` for the post, and once the day's budget is spent the console refuses
  one until tomorrow. The health check counts only unresolved dead letters, and
  the digest says how many of the week's were resolved.
- **Heartbeats** (`ops_heartbeats`): `tick` (each kind dispatched, and the switches tela-jobs runs
  with: the background budget, the article cap, whether a translator, the relay, WebSub and the
  assets bucket are configured), `health` (every fifth minute, what the dead-man's switch heard),
  `daily` (upkeep and the export) and `digest` (once sent). The console reads the budget and the
  relay from the tick's, so after a deploy they show as unknown until the first tick.
- **What it never shows:** a member's subscriptions, reading, likes, highlights or follows, or
  who added a blog: the review queue shows how many read each blog, never who. An audit row never
  holds an email address.

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
  A problem reading `<part> line N is out of key order` means the export read a row twice or out
  of order, and would not restore; the export's paging has regressed (ADR 0027).
- **The exit path off Cloudflare** (ADR 0021), which the suite runs on every commit
  (`apps/api/test/backup.test.ts`):
  1. Copy the bucket, backups included, to any S3-compatible store (`rclone` speaks both).
  2. Create a libSQL database (a file, or Turso), apply `packages/data/migrations`, and call
     `restoreDatabase` from `@tela/data` against the S3 copy (`s3Blobs` in
     `@tela/platform/portable`). Restore into an empty database: it refuses one that holds any
     row of an exported table. A restore that fails partway keeps what it wrote, so start again
     from a fresh database rather than running it twice.
  3. Serve `createApp` (`apps/api/src/app.ts`) from any Hono runtime on `libsqlDb` and `s3Blobs`,
     run `runPortable` (`apps/jobs/src/portable.ts`) beside it for the sweeps, and serve the
     built SPA and `createEdge` (`apps/reader/worker/edge.ts`) in front. Every dependency is
     already an interface with a portable adapter.

## Curation

Discover has three doors (ADR 0018): the editorial list, a verified claim, and three distinct
subscribers on an unclaimed site; and the operator reviews every blog a member adds (ADR 0041).
A public reader count is shown only from three readers.

- **Apply the editorial list:** `ADMIN_TOKEN=… bun run admin curate` adds each blog in
  `apps/api/scripts/curated-sites.ts` (fetched and parsed, so its declared home is honoured) and
  features it with its topics, one blog a request. Running it again changes nothing that is
  already right. A rejected blog is left alone; a claimed one keeps its owner's topics.
- **Review the blogs members add:** Discover → To review lists each private, unclaimed blog that
  someone reads and a live feed has filled, with its language, its posts of the last 30 days, its
  latest post, its readers and when it was added. List it, or Not for Discover; either takes it
  out of the queue and is recorded as the blog's review (`sites.review`, `listed` or
  `dismissed`, with `reviewed_at`), and either can be undone, which puts it back. Not for
  Discover is no veto: three readers still list the blog. A blog listed without topics shows only
  under All, so give it some in its record. The digest counts the queue every Monday.
- **Feature or hide a blog:** in the console, Discover or Sites → Feature, List, Hide or
  Restore. Feature and List record the review as listed, curation too, so a blog you listed stays
  in Discover when you unfeature it or its claim is removed. Hide (`rejected`) is the veto
  curation and every door leave alone; it keeps the review already made (a listed blog hidden and
  restored is listed again), and over nothing decided records not for Discover. Restore returns a
  blog to what the doors and the review say, and leaves the review as it is. `private` is not
  offered: an unclaimed blog with three readers is listed again on the next subscribe.
- **Take a blog off Tela when its writer asks** (Terms, "Writers' work"): hide it, which takes it
  out of Discover and makes its page a 404, and pause each of its feeds (Feeds → Fetching, searched
  by the blog's address). Fetching, page
  extraction and WebSub renewal all read only `status = 'active'` feeds, and nothing revives a
  paused one (the weekly retry is for `'dead'`). Posts already fetched stay with their
  subscribers.
- **Release a claim** so another member can claim the site: Claims → Verified → Remove claim. The
  claim stays, failed, so the claimer's device learns it (a deleted row would never reach it); the
  blog loses its owner, their translation opt-out and the feeds it declared, and stays listed only
  if three people read it or an operator listed it (its review is `listed`).
- **Vouch for a claim** whose check cannot see the proof (a page behind bot protection, a tag in
  the wrong place): Claims → Verify by hand. The check then skips the proof, and still reads the
  home page for the feeds the blog declares.

## Translation

- **Spend:** `select * from usage_daily order by day desc limit 14` (subject `'*'` is background
  titles, anything else a member), and per call `select job, model, count(*), sum(input_tokens),
  sum(output_tokens) from llm_calls where created_at > … group by job, model`. The digest has the
  week's totals.
- **Budget:** `LLM_DAILY_BUDGET_TOKENS` stops the title sweep for the rest of the UTC day once
  spent. Reader requests still run, metered per member (30 requests an hour, a daily token
  allowance). A body converted between the Chinese scripts costs nothing and has its own limit
  (`convert`, 600 an hour), so reading Simplified posts in Traditional never uses up the paid one.
- **A Chinese body paid for twice** (ADR 0038): the Simplified and Traditional requests for one
  post that overlap each pay the model for the same blocks. This finds them (a request cut short
  by its reservation, and finished by the other, shows too):
  `select s.content_key, s.used_tokens, t.used_tokens from body_translations s join
  body_translations t on t.content_key = s.content_key and t.lang = 'zh-Hant' where s.lang =
  'zh-Hans' and s.used_tokens > 0 and t.used_tokens > 0`. If it returns more than the odd row,
  build the coordination the ADR describes: one model job per body and Simplified.
- **Retranslate titles:** `delete from article_titles where article_id in (…)`; the sweep finds
  them again. A title that is its own translation is recorded as `echo` and not retried.
- **A stuck body:** `select * from body_translations where state in ('requested', 'running')`. A
  row stays `running` between executions of one request and needs nothing; one that exhausted its
  attempts is `failed`, with its dead letter beside it, and its reservation is back on the
  member's `usage_daily` row with what it spent charged. The block cache keeps what was
  translated, so a retry pays only for the rest.
- **Switch provider:** change `LLM_PROVIDER`, `LLM_MODEL` and the key, and deploy tela-jobs.
  Cached blocks keep their `model`, so old and new output can be compared.
- **Add a reading language:** the recipe is in AGENTS.md ("How to"). Deploying one makes every
  article's title due in it at once, since `titleIsDue` has no age limit: the archive is translated
  over the following hours or days under `LLM_DAILY_BUDGET_TOKENS` (French, for 1,197 articles,
  took 91 calls and about 320k tokens over eleven minutes). Watch it with `select target_lang,
  count(*), sum(input_tokens + output_tokens) from llm_calls where job = 'translate.title' and
  created_at > … group by target_lang`. Traditional Chinese costs nothing to backfill: it is
  converted from Simplified, so `llm_calls` never has a `zh-Hant` row (ADR 0038).

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

- **To open Tela up**, three steps in this order (ADR 0034):
  1. **A large operator code**, posted where newcomers will see it:
     `ADMIN_TOKEN=… bun run admin code <TEXT> --uses 100000`. Everyone with the link can join,
     the gate still counts them, and `bun run admin revoke <TEXT>` closes it again.
  2. **Lift the invitation gate**: a code change, with an ADR of its own, to `user.create.before`
     and the mail gate in `apps/api/src/auth.ts`, so an address with no invitation is mailed a
     code and given an account. Deploy tela-api.
  3. **Remove `TELA_PRIVATE_BETA`** from `apps/reader/wrangler.jsonc` and deploy tela-web, which
     lets search engines in.

  Out of order, the site says the wrong thing: indexed while it still refuses everyone without
  an invitation (step 3 first), or admitting everyone while it tells search engines to ignore it
  (stopping before step 3).
- **The next Node LTS**, for the relay only, **after 2026-10-28**, when Node 26 reaches LTS; Node 24 <!-- node-pin:planned -->
  enters maintenance on 2026-10-20, so the two dates make one clean move. Five pins change <!-- node-pin:planned -->
  together: `.node-version`, `engines`, the relay Dockerfile's runtime stage, the CI
  `node-version` and `@types/node`, plus the Node major the living docs name. `test/docs.test.ts`
  fails until they all agree.
- **China checks** from a mainland connection once readers there are invited: the first sync, and
  images from hosts like `mmbiz.qpic.cn`.
