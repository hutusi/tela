# Operations

How Tela is provisioned, deployed and kept running: three Cloudflare Workers, D1, R2 and Queues
(ADRs 0020–0027), at https://telaread.com. The old address, tela.ainaive.com, redirects there
through a fourth Worker (*The address*, ADR 0042), and a fifth, tela-gateway, serves the API for
approved apps at https://api.telaread.com (*tela-gateway*, *Apps members register*, ADRs
0064–0067).

## Environments

| Component | Where | Notes |
|---|---|---|
| tela-web | Worker at the reader's edge, unpinned (`apps/reader`) | The only public Worker: static SPA, public pages, `/o/*`, `/img/*`, the `/api/*` forward. Custom domain `telaread.com` only; `workers.dev` stays off (blocked in mainland China) |
| tela-api | Worker pinned to `aws:ap-southeast-1` (`apps/api`) | Sign-in, sync, mutations, every reader RPC, the OAuth server and the API for apps (`/gateway/*`). No public route: tela-web and tela-gateway reach it over service bindings |
| tela-gateway | Worker at the app's edge, unpinned (`apps/gateway`) | The API for approved apps (ADR 0065): bearer tokens only, `/o/*`, `/img/*` and `/v1/bodies` from R2, `/v1/*`, `/meta` and OAuth's endpoints to tela-api's `/gateway/*`, anything else 404. Custom domain `api.telaread.com` only; `workers.dev` off. No D1, no vars, no secrets |
| tela-jobs | Worker pinned to `aws:ap-southeast-1` (`apps/jobs`) | Crons, queue consumers, the `Ingest` RPC. No public route |
| tela-redirect | Worker, no bindings (`apps/reader/redirect`) | `tela.ainaive.com` and `www.telaread.com`: a redirect to the same path on telaread.com, and the shell's kill switch at `/sw.js` (*The address*) |
| D1 `tela` | Primary in Singapore (`--location apac`) | 6–10 ms from the pinned Workers; Time Travel keeps 30 days |
| R2 `tela-content` | Private | Content, translation and chunk objects (served by tela-web to members and by tela-gateway to apps), raw item HTML, members' uploaded pictures (`avatars/`, served by tela-api at `/avatar/…`, ADR 0033), and the nightly `backup/`. The pictures are member data the D1 export does not hold: a move off Cloudflare copies `avatars/` too |
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
| `PUBLIC_URL` | tela-api, tela-jobs | The one public origin, `https://telaread.com`: better-auth's base URL and trusted origin, the profile links a claim looks for (with `www.` and the old `tela.ainaive.com`, ADR 0045), the WebSub callback |
| `API_URL` | tela-api | The API's origin for apps, `https://api.telaread.com` (ADR 0065), with no trailing slash: the OAuth issuer, named in the metadata and in every `iss` a consent answer carries (RFC 9207), where the token and revocation endpoints are said to be, and where the authorization endpoint is not (that is `PUBLIC_URL/connect`, ADR 0064). Required: a wrong one puts a wrong `iss` in front of every app. Locally, `apps/api/.dev.vars` points it at the gateway's own port, `http://localhost:8788` (*Running locally*) |
| `TELA_NOINDEX` | tela-web | `1`: robots.txt is `Disallow: /` and every answer the Worker serves carries `X-Robots-Tag: noindex, nofollow` (ADR 0060; it was `TELA_PRIVATE_BETA`, ADR 0015). Unset: each public page follows its own rule (its meta robots, mirrored as `X-Robots-Tag`), and robots.txt welcomes search engines and answer tools but not training crawlers. The SPA shell is a static asset the Worker never sees, so it is noindex by its own meta tag, always. Set until launch day, whatever `signup.mode` says |
| `GRAVATAR_URL` | tela-api, tela-jobs | Where members' pictures are fetched from (tela-api, ADR 0032) and asked about (tela-jobs, ADR 0033), default `https://gravatar.com/avatar`. The e2e points it at its fixture server. A picture is cached for 30 days in each colo and browser under an address with its version, and turning the switch off cannot purge a colo: a copy already held stays, at an address nothing links to any more |
| `GITHUB_TOKEN` | tela-jobs (secret, optional) | A fine-grained GitHub token with no repository access and no permissions, for a claim by GitHub (ADR 0045): it asks `api.github.com/user/<id>` for a member's login and website, which needs no permission. Unset, GitHub allows 60 requests an hour per egress IP, and Cloudflare's egress IPs are shared with other customers, so a check may find GitHub refusing (`github_unavailable`) for reasons of someone else's making. Set, 5,000 an hour. Make it under the owner's account, with the longest expiry GitHub allows, and diary its renewal: an expired token answers 401, which a claim also reads as `github_unavailable` |
| `GITHUB_API_URL` | tela-jobs | Where GitHub's API answers, default `https://api.github.com`. For a test stack only |
| `ENV` | tela-api, tela-jobs | `test` in local dev and e2e only: the sign-in outbox, `POST /api/test/cycle`, `POST /api/test/age` (a profile made older, past the week a new account waits), and fetches to private addresses. Never deployed |
| `WORKER_USER_AGENT` | tela-jobs | Sent on every fetch; keep a contact URL in it, and keep it starting `Tela/`: a claim page tells a writer whose site turns Tela away to let that through |
| `FETCH_TIMEOUT_MS` | tela-jobs, the relay | Per-request timeout, default 20000 |
| `WEBSUB_ENABLED` | tela-jobs | `1` subscribes at feeds' hubs; hubs verify by calling `PUBLIC_URL/api/websub/<feedId>` |
| `LLM_PROVIDER` | tela-jobs | `bailian` (default), `anthropic` or `mock`. Without the matching key the provider falls back to the mock, and the translation kinds are then disabled rather than caching placeholder output; set `mock` on purpose for local runs only |
| `LLM_MODEL` | tela-jobs | `glm-5.2` (Bailian default), `claude-opus-5` (Anthropic default) |
| `BAILIAN_API_KEY`, `BAILIAN_BASE_URL` | tela-jobs (key secret) | The key is a mainland one: leave the base URL unset (`dashscope.aliyuncs.com`; the international endpoint refuses it) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | tela-jobs (key secret) | Anthropic, if ever used |
| `LLM_JSON_MODE` | tela-jobs | `text` (parse JSON from the reply; Bailian's default) or `schema` (structured output; Anthropic's) |
| `LLM_DAILY_BUDGET_TOKENS` | tela-jobs | Day cap for background title translation; `0` = unlimited. Production sets 2,000,000 in `apps/jobs/wrangler.jsonc`, so every deploy carries it (until 2026-10-04 it was set nowhere, and titles ran uncapped). Read only while the runtime setting `translation.backgroundDailyTokens` is null (ADR 0057); body requests are counted per member and held to `translation.siteDailyTokens` instead |
| `LLM_MAX_ARTICLE_TOKENS` | tela-jobs | Source tokens translated per body (default 40,000); the rest stays as source and the translation is `partial` |
| `LLM_MOCK_DROP_MARKER` | tela-jobs, tests only | With `LLM_PROVIDER=mock`, the mock drops every block containing this text, so a run can reach `partial` |
| `RELAY_URL`, `RELAY_SECRET` | tela-jobs (secret) | The relay's origin and shared signing secret. Unset (as now): feeds never change region |
| `RELAY_CONTROL_URL` | tela-jobs | Fetched before flipping a feed to the relay; if it fails too, the problem is Cloudflare's network, not the feed (default: Cloudflare's trace endpoint) |
| `RELAY_SECRET`, `RELAY_SECRET_PREVIOUS`, `RELAY_PORT` | the relay | Accepted secrets (the previous one during rotation) and the listen port (8787) |
| `DEADMAN_URL` | tela-jobs (secret) | The healthchecks.io ping URL; see *Knowing it runs* |
| `DIGEST_TO` | tela-jobs (secret) | Who gets the Monday digest and the operator's alerts (the owner). Unset, the digest is built but not sent, and no alert is checked |
| `VITE_ASSETS_URL` | tela-web build | Public base of `tela-assets`; defaults to `https://assets.telaread.com` |
| `ASSETS_URL` | tela-api | The same base, for the absolute favicon URLs the API gives apps (`faviconUrl`, ADR 0065); defaults to `https://assets.telaread.com`. Keep it equal to `VITE_ASSETS_URL` |
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
   4. `cd apps/gateway && wrangler deploy`: tela-gateway, the API for approved apps (ADR 0065).
      It forwards to tela-api's `/gateway/*`, so it goes after tela-api; after tela-web too, by
      habit, since nothing it serves is new to a member. The custom domain is the `routes` entry
      in `apps/gateway/wrangler.jsonc`: **the first deploy creates the DNS record for
      `api.telaread.com`**, which is a change to the zone, so the owner runs or authorizes it.
      Nothing may sit on `api` in the zone's DNS beforehand. Check it with `curl -s
      https://api.telaread.com/.well-known/oauth-authorization-server` (the issuer
      `https://api.telaread.com`) and `curl -sI https://api.telaread.com/v1/me` (401 with
      `www-authenticate: Bearer` and `tela-api-version: 1`).
   5. `cd apps/reader/redirect && wrangler deploy -c wrangler.jsonc`: tela-redirect, which holds
      the old address and `www` (*The address*). It changes rarely; deploy it only when it does.

   **A release that bumps `MIN_CLIENT` reverses tela-api and tela-web:** tela-web first, then
   tela-api within minutes. A shell on the new protocol still works against the old tela-api, but the new
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
   - Discover's four tabs (ADR 0044, migration 0008) are additive and keep protocol 2, with no
     `MIN_CLIENT` bump. The migration only adds two indexes (`articles_sort_idx`,
     `recommendations_created_idx`). Apply it, then deploy tela-api, then tela-web (tela-jobs is
     unchanged):
     - tela-api before tela-web, because the new shell reads `/api/v1/public/discover/week`,
       `/articles` and `/readers`. A tela-web out first shows visitors the plain shell at those
       paths (never cached; the edge treats tela-api's 404 there as no answer) and members empty
       tabs and an empty "Readers to follow", until tela-api is out.
     - **Either Worker may go back alone.** An older tela-api answers the new tabs with nothing;
       an older tela-web shows the old one-page Discover. `/api/v1/following` keeps answering
       `suggested: []` for shells cached before the tabs.
     - After deploy, check that:
       - `/discover` shows This week to a visitor, and `/discover/blogs` shows no count below
         three;
       - `curl -sI 'https://telaread.com/discover?topic=tech'` is a 301 to
         `/discover/blogs?topic=tech`;
       - `/discover/readers` as a visitor shows no "Recommended posts you liked too" or "Read the
         blogs you read" group;
       - Following's "Readers to follow" lists the same people as Discover's Readers.
   - Claims an operator's no holds (ADR 0045, migration 0010) bump `MIN_CLIENT` to 3: a claim
     page cached before them cannot word the new reasons. The migration adds
     `site_claims.overruled_at` and carries over earlier rejections and removals from the admin
     ledger. Apply it, then deploy tela-web, then tela-api within minutes, then tela-jobs:
     - tela-web before tela-api, as for any bump. A device's copy stays where it is (`tela-2`
       is the database's own name, not the protocol's); a stale shell only reloads.
     - tela-jobs last, because an older tela-api shows a reason it does not know as its raw
       JSON. An older tela-jobs meanwhile only ignores `overruled_at`.
     - Rolling back: tela-web may not go back while the new tela-api is live. tela-api and
       tela-jobs may, and the migration can stay.
   - Folders (ADR 0048, migration 0011) are additive and keep protocol 3, with no `MIN_CLIENT`
     bump. The migration adds `folders` and `feed_folders`. Apply it, then deploy tela-jobs,
     tela-api, tela-web, the usual order:
     - tela-jobs first, because tela-api reads an OPML file's folders from its `readOpml`. An
       older tela-jobs sends none, and an import then files nothing, as before.
     - tela-api before tela-web, because the new shell sends `putFolder`, `deleteFolder` and
       `fileFeed`. An older tela-api refuses them as invalid, so a folder made, renamed or
       deleted, or a blog moved, visibly goes back.
     - Each device starts over from a snapshot once, at its first boot on the new shell: its copy
       has no folder tables. It starts over again at a boot after a tab of the earlier shell, left
       open, has pulled into the shared copy (`kept` in `apps/reader/src/store/db.ts`): that tab
       moved the cursor past folder rows it dropped. That boot waits on the network for its list.
     - **Either Worker may go back alone.** An older tela-web shows the flat sidebar and Settings,
       and ignores the folder rows a pull sends. An older tela-api sends no folder rows, so a
       device keeps the folders it holds, or none if it took a snapshot meanwhile. Once tela-api
       is forward again, each device's first pull asks for a snapshot, because its copy recorded
       the folder tables as not whole (`kept`).
     - A folder change still unsent when a Worker goes back is not kept for later:
       - Under an older tela-web, the shell sends it as queued, since it pushes whatever is queued
         whatever its type, and the newer tela-api applies it. That shell only shows nothing of
         it.
       - Under an older tela-api, the push is refused as invalid and the change leaves the queue,
         from whichever shell sent it. A folder made, renamed or deleted, or a blog moved, in
         that window, is lost, and the member has to do it again once tela-api is forward.
         Keep a tela-api rollback short.
     - After deploy, check that:
       - a folder made in Settings shows in the sidebar, and on a second device after its pull;
       - a folder's list (`/reading?folder=…`) has Mark all read, and its Undo works;
       - an OPML export holds the folder as an outline, and importing that file into another
         account makes the folder there.
   - The Subscriptions manager (ADR 0049) changes no table and keeps protocol 3. The pull sends
     each feed's `lastItemAt` (`feeds.last_item_at`), which a device learns at each feed's next
     fetch, since every fetch stamps the feed row's `seq`. Either Worker may go first or go back
     alone. An older tela-api sends no date, and the column falls back to the posts the device
     holds: a blog quiet past the 30-day horizon then reads "No posts yet". An older tela-web shows
     0048's sections and ignores the field.
   - Blogrolls (ADR 0050, migration 0012) are additive and keep protocol 3, with no `MIN_CLIENT`
     bump. The migration adds `blogrolls` and `blogroll_blogs`. Apply it, then deploy tela-jobs,
     tela-api, tela-web, the usual order:
     - The migration first, because the new tela-jobs's `mergeFeed` writes `blogroll_blogs` in the
       batch that merges a feed. Without the table that batch fails, and the alias goes on being
       fetched beside its target until the migration lands.
     - tela-jobs before tela-api, so that a merge after the first blogroll exists carries it. An
       older tela-jobs leaves the alias's row in the blogroll, which mostly still works: the
       public answers keep it, and its row's Subscribe subscribes to the target. Subscribe to all
       leaves such a blog alone (its changes are `exact`, so they never reach a subscription
       through a merge).
     - tela-api before tela-web, because the new shell sends `putBlogroll`, `setBlogrollPublic`,
       `deleteBlogroll`, `rollBlog`, `unrollBlog` and `noteBlog`, and reads
       `/api/v1/public/blogrolls/:id` and `/api/v1/public/discover/blogrolls`. With tela-web out
       first, whatever a member makes is refused as invalid and visibly goes back, `/l/<id>` is
       Not found, and Discover's Blogrolls tab is empty (the edge treats that path as one that
       always exists, so visitors get the plain shell, never a cached 404).
     - Each device starts over from a snapshot once, at its first boot on the new shell: its copy
       has no blogroll tables (`kept`, as for folders).
     - **Each Worker may go back alone**, and the migration can stay:
       - An older tela-jobs only stops carrying blogroll rows through a merge.
       - An older tela-api refuses the six mutations as invalid, so a blogroll made, edited,
         filled or deleted in that window goes back and is lost; `/l/<id>` answers 404 and
         profiles carry no blogrolls (the shell reads none). Its pulls carry no blogroll tables, so
         each device asks for a snapshot once tela-api is forward again. It also strips `exact`
         from `subscribe`, `unsubscribe` and `fileFeed`, so a Subscribe to all from a public copy
         naming a merged address follows the merge again. Keep it short.
       - An older tela-web ignores the blogroll rows a pull sends and has no `/l/` page, and still
         sends any blogroll change left queued, which the newer tela-api applies.
     - After deploy, check that:
       - a blogroll made from a profile's Blogrolls tab opens at `/l/<id>`, takes blogs from Add
         blogs, and shows on a second device after its pull;
       - once public with three blogs, `curl -s https://telaread.com/l/<id>` (no cookie) holds its
         name and `tela-data`, `/discover/blogrolls` lists it within five minutes, and a private
         one answers 404;
       - the admin console's Discover area has a Blogrolls filter that lists it.
   - Titles in the reading language (ADR 0052) change no table and keep protocol 3, with no
     `MIN_CLIENT` bump. A device keeps titles in its reading language only: each pull names it
     (`?titles=<lang>`, answered with `titlesLang`), and when its titles are not whole (a switch,
     or another tab's cursor) it asks for them again by article id (`POST /api/v1/sync/titles`). Deploy tela-api, then tela-web; tela-jobs is
     unchanged:
     - tela-api first, because the new shell names a language on every pull and fetches titles by
       id. A protocol-3 shell names none, and the new tela-api sends it every language, as before.
     - No device starts over. A copy from before keeps its reading language's titles, whole, and
       lets the others go at its first boot on the new shell. A copy that a tab of the earlier
       shell, left open, has pulled into since is not whole: the device asks for its titles again
       by id, every one held since some may be stale, and shows untitled posts as written until
       then (the `titles` record in
       `apps/reader/src/store/db.ts`).
     - **Either Worker may go back alone.**
       - An older tela-api ignores `?titles=` and sends every language, which the new shell
         filters, and answers the titles route 404, which the shell takes as "next pull": a member
         who switches language in that window sees posts as written, the newest excepted, until
         tela-api is forward again. Nothing is lost, and no device starts over.
       - An older tela-web pulls every language again into the copy the new shell kept, and
         shows the reading language's titles it finds there. A member who switches language under
         it sees the older posts as written. Forward again, the new shell finds its record stale,
         lets the other languages go and fetches what is missing.
     - After deploy, check that:
       - `GET /api/v1/sync?cursor=0&titles=<lang>` is a fraction of `?cursor=0` (encoded size,
         with the page's member headers);
       - switching the reading language in Settings shows posts as written, then their titles in
         the new language, with no `cursor=0` request;
       - Workers Logs show no new `client error` lines.
   - The public-launch round (ADRs 0056–0063, migration 0014) bumps `MIN_CLIENT` to 4: a cached
     shell would poll a translation that waits for tomorrow every 1.5 s, and word a site-wide pause
     as the member's own allowance. Migration 0014 only adds tables, columns and indexes (no table
     is rebuilt). Apply it, then deploy tela-jobs, then tela-web, then tela-api, within minutes:
     - tela-jobs first, because an older one claims a waiting body at once and reports no
       `siteBudget`, and it is the new one that knows `member.pendingFeeds` and `member.erase`. It
       reads a body the older tela-api reserved meanwhile as that one meant it, source tokens
       (`reserved_spend` unset, ADR 0057);
     - tela-web before tela-api, as every `MIN_CLIENT` bump. tela-web may not go back while the
       new tela-api is live; tela-api may go back alone.
     - Deploy with `signup.mode` at its default, `invite`, and `TELA_NOINDEX` still set: nothing a
       visitor sees changes until launch day (*Launching*).
     - After deploy, check that:
       - `bun run admin settings` lists every setting with its default;
       - the console's Settings, Reports and Translation areas open, and Translation shows today
         against the site budget;
       - `curl -s https://telaread.com/robots.txt` still says `Disallow: /` and `/sitemap.xml`
         answers;
       - opening a post in another language translates it, and a member's Settings › Language
         shows how many of the day's 20 are used (an admin's shows none: admins are exempt);
       - the health check stays ok through the first 00:00 UTC (waiting bodies start then).
     - Run `bun run restore-drill` after the next nightly export, so the new tables are covered.
   - Approved apps and the daily limit on posts from unfollowed blogs (ADRs 0064–0066, migration
     0015) bump `MIN_CLIENT` to 5: public answers lose their content keys, and a body may be
     refused for the day's limit, neither of which a protocol-4 shell can read. Migration 0015
     only adds tables (`apps`, `app_grants`, `app_tokens`, `app_refresh_spent`, `app_codes`,
     `post_opens`). Apply it, then deploy tela-jobs, tela-web, tela-api within minutes, then
     tela-gateway:
     - The migration first: tela-jobs' daily batch sweeps `post_opens`, and tela-api's every body
       decision writes it.
     - tela-jobs first, because tela-api now tells the `Ingest` RPC who is exempt; a tela-jobs from
       before reads `is_admin` itself, so an app acting for an admin would be exempt from the
       day's new feeds.
     - tela-web before tela-api, as every `MIN_CLIENT` bump. This tela-web also asks tela-api
       before it serves any body, translation or image (`POST /api/edge/opens`); until tela-api
       is out, every one of them answers 503 (`opens decision unavailable 404` in tela-web's
       logs), so keep the gap to minutes. Bodies already on a device still open.
     - tela-gateway last: it needs tela-api's `/gateway/*`. Its first deploy creates
       `api.telaread.com` (step 4 above).
     - Rolling back: **tela-api and tela-web go back together**, tela-api first, then tela-web at
       once. An older tela-api alone has no `/api/edge/opens`, so this tela-web refuses every
       body; an older tela-web alone is told to upgrade by this tela-api. tela-jobs may go back
       alone (its sweep leaves `post_opens` growing until it returns). tela-gateway may go back,
       or be deleted, alone: only apps notice. The migration can stay.
     - After deploy, check that:
       - `curl -s https://telaread.com/discover | grep -c contentKey` is 0, and the same for
         `/api/v1/public/discover/week`;
       - opening a post from a blog you do not subscribe to shows it, and
         `/api/v1/account/usage` counts it under `posts` (`select count(*) from post_opens where
         day = date('now')`); an admin's account counts nothing on the web;
       - the console has an Apps area, and its Settings list `member.unsubscribedPostsPerDay`
         (100) and `apps.enabled` (on);
       - the gateway answers as in step 4, then the mainland check (*tela-gateway*);
       - a draft app registered to your own account connects and pulls (*Apps members register*).
     - Run `bun run restore-drill` after the next nightly export, so `apps` and `app_grants` are
       covered.
   - Apps members register (ADR 0067, migration 0016) bump `MIN_CLIENT` to 6: the consent page
     must say when an app is not reviewed, which a protocol-5 shell cannot. Migration 0016 adds
     plain columns to `apps` and rebuilds `reports` for the target kind `app`:
     - **Take a Time Travel bookmark first** (`wrangler d1 time-travel info tela`), since the
       migration rebuilds a table; then apply it, then deploy tela-web, then tela-api within
       minutes. tela-jobs and tela-gateway are unchanged.
     - Rolling back: tela-api and tela-web go back together. A tela-api from before this release
       knows nothing of reviews: every app would be treated as the operator's, with no cap, no
       email ban and no developer standing check. The migration can stay.
     - After deploy, check that Settings → Developer registers an app on your account and connects
       it in Testing, that the console's Apps area opens on *To review*, and that `bun run admin
       settings` lists `apps.unreviewedMaxConnections` (100) and `apps.perMember` (5).
   - The AI topic and the AI labs (ADR 0068) bump `MIN_CLIENT` to 7: a protocol-6 shell shows a
     blog's topic `ai` as its key. No migration (`site_topics` has no CHECK).
     - Deploy tela-jobs first (Add's discovery offering a listed blog's feeds runs there), then
       tela-web, then tela-api within minutes; tela-gateway is unchanged.
     - Then `bun run admin curate`, never before tela-api: curate drops a topic tela-api does not
       know, and a lab listed under AI alone would be listed under nothing. The same run adds the
       54 blogs from the HN Popularity Contest's list, about 1,550 posts in their feeds: expect
       their titles to spend about 1M tokens that day, as 20 blogs and 1,611 posts did on
       2026-10-09. Chris Siebenmann's server answers 429 to a client that asks too often; its
       first fetch may wait out a backoff.
     - Rolling back: tela-api and tela-web go back together. The labs stay listed; an older build
       shows them under All only, and `?topic=ai` reads as no topic. tela-jobs may go back alone:
       Add then says "No feed found" at a lab's address again.
     - After deploy, check that Discover shows the AI chip and `/discover/blogs?topic=ai` lists the
       labs and the writers; that Add, given `https://www.anthropic.com/engineering`, offers
       Anthropic's Research and Engineering feeds; that Anthropic's card in Discover subscribes to
       Research, though Engineering was added first (`mainFeed`); and, once OpenAI's posts are
       fetched, whether their extraction got through (`select extract_state, count(*) from
       articles where url_host = 'openai.com' group by 1`). If it was refused, its posts stay
       excerpts, as ADR 0068 accepts.
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

1. **Gate G2 passed** on 2026-10-07: the shadow tela-jobs matched the Fly worker's articles by
   dedup key. Its Worker, D1, queues and `env.shadow` block were deleted on 2026-10-22, and its
   bucket `tela-content-shadow` was given a one-day expiry rule, to be deleted once empty.
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
because their configs name the same ones. Beside Vite, the same command runs tela-gateway (ADR
0065) in a `wrangler dev` of its own at http://localhost:8788, the local `api.telaread.com`: it
reaches tela-api in the Vite process through wrangler's local dev registry, and reads the same
bucket (`--persist-to apps/reader/.wrangler/state`). It needs no `.dev.vars`.

```sh
S=$(openssl rand -hex 32)
printf "AUTH_SECRET=$S\nADMIN_TOKEN=local\nENV=test\nPUBLIC_URL=http://localhost:5173\nAPI_URL=http://localhost:8788\n" > apps/api/.dev.vars
printf "ENV=test\nLLM_PROVIDER=mock\nPUBLIC_URL=http://localhost:5173\n" > apps/jobs/.dev.vars
printf "AUTH_SECRET=$S\nTELA_NOINDEX=1\n" > apps/reader/.dev.vars
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

To try an app (ADR 0064) locally: sign in as an admin (`dev:seed` makes one), register an app in
`/admin/apps` with your own handle as its owner and `http://127.0.0.1/callback` as its redirect,
and follow `docs/api/authorization.md` with `http://localhost:5173/connect` for
`https://telaread.com/connect` and `http://localhost:8788` for `https://api.telaread.com`. The
draft connects for your account only, as it would in production. `API_URL` in `.dev.vars` is what
makes the metadata and every `iss` name the local gateway.

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
writing `.dev.vars` beside the real configs would clobber a developer's own. It writes a fourth,
tela-gateway's, which `run.sh` starts in a `wrangler dev` of its own on port 8812
(`E2E_GATEWAY_URL`), since only a session's first Worker answers on its port; it reaches tela-api
through the local dev registry and reads the same state directory.

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
- **Bodies, translations and images ask tela-api first** (ADR 0066): `POST /api/edge/opens` with
  the member's cookie, for the posts this colo has not already allowed them today, which it then
  keeps until midnight UTC. `opens decision failed` (the binding threw) or `opens decision
  unavailable <status>` (tela-api answered something else: a 404 is a tela-api from before the
  route) in the logs means members get 503 for every body not already on their device. A member
  refused for the day's limit is not an error: a 429 `post_limit`, which the reader shows as the
  post's excerpt and *Subscribe to keep reading*. Browsers get 404 for `/api/edge/*`.
- **Public pages** (the front page `/`, Discover's five tabs, `/s/:id`, `/@handle`, a blogroll's
  `/l/:id`) are rendered here and kept in each colo's cache for five minutes, keyed by locale and
  by the build. So a deploy never serves a page that names scripts it removed, and a blog's change
  shows within five minutes. There is nothing to purge. A 404 is kept as long (ADR 0050): if
  someone opened a blogroll's link while it was private, the colo answers that link with its Not
  found page for up to five minutes after the blogroll is made public. The app replaces it as soon
  as its own request finds the blogroll; without a script, the page stays Not found until the copy
  expires. The other way, a blogroll made private is a 404 to a fresh visit within minutes (the
  colo's five, then the browser's one), while a page already open keeps what it shows. The owner's
  own blogroll renders from their device over the 404 page, so a private one opens for them on any
  device that has pulled it. `/` is rendered only for a request without `tela.session_token`; a
  member's is the plain shell. If `/` shows the plain shell to signed-out visitors (a 503 with
  `Retry-After`, ADR 0060), tela-api's `/api/v1/public/front` is not answering 200 within three
  seconds (deploy tela-api before tela-web when it is new): tela-web logs `public page data late`
  or `public page data failed` with the endpoint, which says which.
- **Hashed assets** (`/assets/*`) are kept a day by the browser (`public/_headers`, ADR 0051),
  not a year: the single-page fallback answers a name a deploy lacks 200 with `index.html` under
  the same rule. After a tela-web rollback, a browser without the service worker that was handed
  that HTML for a script boots blank on that build until the day is out or a hard reload; the
  worker asks past the browser's cache itself (`cache: 'reload'`) and is not held up. `curl -I
  https://telaread.com/assets/<a file>` shows `cache-control: public, max-age=86400`.
- **Security headers** (ADR 0051): every page carries `Content-Security-Policy-Report-Only`,
  `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`
  and `X-Frame-Options`, from `public/_headers` for the shell and from the Worker for the pages it
  renders; `curl -I https://telaread.com/` and `curl -I https://telaread.com/reading` both show
  them. The CSP only reports for now. **Enforcing it is the owner's call**, after a week in which
  the client-error log shows no `securitypolicyviolation`: rename the header to
  `Content-Security-Policy` in `worker/security.ts` and `_headers` together, and deploy tela-web.
  A violation that does show names the directive and the address it blocked: allow the address in
  both places, or remove what asked for it.
- **Writes to `/api/*` without this origin get 403** `cross-origin write refused`. Hubs
  (`/api/websub/*`) and the admin script (`/api/admin/*`) are exempt. A browser always sends
  `Origin` on a POST, so seeing this from the app means something is proxying it.
- **Errors in readers' browsers** reach tela-api's Workers Logs as `client error` lines (`POST
  /api/client-errors`): `kind` is `boundary` (a view threw and its error boundary showed Try
  again), `error` or `rejection` (left unhandled, only from Tela's own scripts), `boot` (the app
  could not start; its device storage may have refused) or `csp` (a policy violation, ADR 0051),
  with the message, the stack (4 KB), the path without its query and the build. A page sends five
  errors and three violations at most per load, and an IP thirty of each an hour; a violation an
  extension's script set off is never sent. Query strings never reach either Worker's logs
  (`redact_query_string` on tela-web and tela-api, as on tela-redirect): an invite code or a
  sign-in link's `?email=…&otp=…` would otherwise be readable there. After a deploy, a burst of
  one `boundary` message on one path is a bug in that view; `boot` lines from many paths at once
  are the device store or a cached shell.
- **A device that starts over** (lets go of its copy and downloads a whole snapshot) says why,
  as a `client restart` warning on the same route (`kind: restart`, counted with the errors). The
  message names the cause: `load at <cursor>: …` (a stored table missing, or `kept` not written
  at that cursor), `delta at <cursor> sent <tables>, not held whole (…)` (with where the copy's
  record came from: `kept by <build> at <cursor>`, a snapshot, or a pull that left those tables
  out), `tela-api started over a pull at <cursor>` (the database is behind the device's cursor),
  or `claim: another account held the stored copy`. The build is the shell's script
  (`index-<hash>.js`), so a line naming a build that is not live is a cached shell. A table a
  deploy adds makes each device start over once (AGENTS gotcha); any other cause, or a second
  start-over on one device, is a bug to chase.
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
    for the send error, a `MailError`: `Resend answered <status>` when it refused, and `Resend not
    reached: no answer in 10000 ms` when it did not answer in ten seconds. An address with no account is mailed only while it holds an invitation
    (a hold from a join lasts a day); otherwise the request answers as usual and nothing is sent.
  - A member whose sign-in fails on one network only, and works on another, is behind a network
    that refuses telaread.com: the form says "We could not reach Tela from this network" when no
    answer came back at all. A browser that has visited before still draws the page, from the
    shell's cache, which hides the block.
    `wrangler tail tela-web` while they try shows nothing from them; on a company network it is
    usually a web filter that does not yet know the domain (registered 2026-10-06). On 2026-10-10
    an office's proxy refused it for a while, then let it through unasked. The member's IT can
    allow-list the domain; nothing on Tela's side changes it.
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
    `sessions not ended` in the logs when either fails; neither undoes the change). A reset ends
    the member's apps after better-auth has ended the sessions, tried twice: `apps still connected
    after a password reset: user <id>` means both tries failed, and the member's apps still act for
    them; end them with the console's sign-out for that member. A link that
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
| `article.extract` | `extract_state = 'due'`: a summary-only post waiting for its page, set when the feed lists it; never on a blog that chose "Only use what my feed provides" (one left due there is settled to `none` unfetched), and fetched only where the origin's robots.txt lets Tela in (ADR 0061) |
| `article.reprocess` | the article's current version was made under an older `PIPELINE_VERSION` (ADR 0055) |
| `site.assets` | a site's favicon has never been checked |
| `member.gravatar` | a member shows their Gravatar and it was never asked about, or the answer has run out: 30 days after a picture, 7 after none (ADR 0033). Refresh asks again at once |
| `site.claim` | a member asked for their claim to be checked |
| `websub.subscribe` | a hub subscription is new, failed, or near its lease's end |
| `translate.title` | a feed has articles without titles in every launch language |
| `translate.body` | a member asked for a post in their language, and its `due_at` has passed or it has none (ADR 0057) |
| `member.pendingFeeds` | a member in good standing has imported feeds waiting (`pending_feeds`) and their day and cap have room, or a waiting feed is now one Tela has (ADR 0063); a suspended member's wait is kept until the suspension is lifted. Exhausted: the wait moves a day out; Retry brings it back |
| `member.erase` | an account closed at least 10 minutes ago and not yet erased: what its own devices held, in chunks (ADR 0058). Out of attempts it waits on its dead letter; Retry in System makes it due again. A run that finds one of the member's translations still running ends without stamping and comes back next tick |

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
- **Bodies stored before a pipeline fix** are made again by `article.reprocess` (ADR 0055).
  Bump `PIPELINE_VERSION` in `packages/shared/src/constants.ts` with the change to sanitizing,
  normalization, skip rules or excerpts, and deploy tela-jobs: every article whose current version
  was made under an older one is due, newest first, 50 a minute. Each is made again from the raw
  HTML it was stored with; one that comes out different becomes a new version (seq stamped, so
  devices fetch it, and its old body translation stays with the old key), one that comes out the
  same is stamped current. Nothing is fetched, so neither health check's backlog moves. How far it
  has got: `select count(*) from article_versions v join articles a on a.id = v.article_id and
  a.current_version = v.version where v.pipeline_version < <PIPELINE_VERSION>`. To make one again
  without a bump: `update article_versions set pipeline_version = 0 where article_id = … and
  version = (select current_version from articles where id = …)`.

  A fix to *extraction* (Readability's input) needs the page again, which the stored raw HTML is
  not:
  - an extracted post (`article_versions.provenance = 'readability'`): make it due again,
    `update articles set extract_state = 'due' where id in (…)`. The sweep re-fetches each page,
    politely per host, so one host's posts go one at a time. **At most twenty at once:** a post
    fetched over six hours ago counts as waiting for its full text the moment it is due, and more
    than twenty of those fail the health check, which pings the dead-man switch's `/fail` and
    mails the owner. Re-queuing Paul Graham's 200 essays by `url_host` did exactly that
    (2026-10-24). Queue the next ones as these finish;
  - a feed whose items themselves changed: make it process every item it still lists, not just
    answer 304 or match its last body, `update feeds set etag = null, last_modified = null,
    last_body_hash = null, next_fetch_at = strftime('%s','now') * 1000 where id in (…)`. Due
    now rather than at `0`: a feed due for over two hours with no lease counts as overdue, and
    more than three of those fail the health check too.
  A post whose body did not have the fixed shape gets the same content key and no new version,
  so any of these is safe to run over more than the affected posts.
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
  not null`. An alias merges at the tick after its first fetch; one that has not yet (a blog a
  member follows twice) merges at once on the admin console's Fetch now. A merge moves readers,
  their filings, the alias's places in blogrolls (with their notes; ADR 0050) and the posts only
  the alias had (with their titles,
  translations and read states), and deletes nothing. To undo
  a wrong one (a category feed taken for the blog's), reactivate the alias with
  `update feeds set status = 'active', merged_into = null, next_fetch_at = 0 where id = …`.
  Its readers stay on the canonical feed until they subscribe to the alias again.
- Queue messages are only accelerators. Purging a queue loses no work, because the next tick
  finds everything still due.

## tela-gateway

`apps/gateway/wrangler.jsonc`: `api.telaread.com`, the API for approved apps (ADR 0065). Unpinned,
at the app's edge. Its bindings are `BLOBS` (`tela-content`, read-only) and `API` (tela-api); no
D1, no assets, no vars and no secrets, so nothing in it needs rotating.

- **What it does:** drops every cookie, refuses any `Authorization` that is not an access token
  (`Bearer tela_at_…`) except on `/meta`, `/robots.txt` and OAuth's own endpoints, serves `/o/*`,
  `/img/*` and `/v1/bodies` from R2 through the colo cache (asking tela-api's `/gateway/opens`
  first), forwards the rest of `/v1/*`, `/meta`, `/oauth/*` and
  `/.well-known/oauth-authorization-server` to tela-api as `/gateway/<path>`, and answers any
  other path 404 `not_found` itself (`/gateway/opens` is its own question). Every answer says
  `noindex`, HSTS and `tela-api-version`. `robots.txt` disallows everything.
- **Caches** (the colo's, purged by nothing): an allowed post per token for 60 s, so an app cut
  off loses its images within a minute; a public answer that names `?lang=` for five minutes, by
  path and query, served only to a token tela-api accepted in the last minute; and `/meta` for
  five minutes, for every caller, so an operator's change to a daily limit reaches what it says
  within those five minutes. A blog hidden or a profile suspended leaves the apps' public pages
  within those five minutes, as on the web.
- **Logs:** paths only (`redact_query_string`: a query names content keys and a member's
  searches). Failure signatures:
  - `tela-api unreachable <path>`: the binding failed; apps get 503 `unavailable` with
    `Retry-After: 30`. tela-api is down or deploying.
  - `opens decision failed` or `opens decision unavailable <status>`: tela-api could not decide
    what a token may open (a 404 is a tela-api without `/gateway/opens`); apps get 503 for bodies
    and images, nothing else.
  - A run of 401s from one app is its tokens refused: the app cut off, its member's connections
    ended, or a bug in its refresh. tela-api's own log `refresh token reused; device ended`
    (with the `clientId`) is a spent refresh token that came back: a few are an app racing its
    own refreshes, which the developer should fix; many from one app are worth asking about.
- **Rate limits:** tela-api counts each app per member and in all, but only after resolving the
  token, one D1 round trip each. **A suggested Cloudflare rule** in front of it, so a flood of
  junk is stopped at the edge (Security → WAF → Rate limiting rules, on the telaread.com zone; the
  owner's to add): when `http.host eq "api.telaread.com"`, counted per IP, 300 requests in 10
  seconds, block for 10 seconds. That is far above one member's app (120 calls a minute, plus a
  post's images in a burst) and leaves room for an office behind one address. Where the plan
  allows a second rule, `http.host eq "api.telaread.com" and starts_with(http.request.uri.path,
  "/oauth/")` at 20 in 10 seconds. Read Security → Events after the first week, and loosen a rule
  that blocks real apps.
- **The mainland check**, after the first deploy: boce.com (or itdog.cn) against
  `https://api.telaread.com/meta` and `https://api.telaread.com/robots.txt`, beside the same run
  for `https://telaread.com/`. ADR 0042 kept one origin because `workers.dev` is blocked there; a
  telaread.com subdomain should answer wherever telaread.com does. A node that fails on
  `api.telaread.com` but not on `telaread.com` is the subdomain's problem; one that fails on
  both is that network's, as before.
- **Locally**, `bun run dev` runs it at http://localhost:8788, and the e2e on port 8812
  (*Running locally*, *End-to-end*).

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
  - *the last tick could not run <kind> (<error>)*: one kind's due query, claim or send failed,
    and the tick went on with the others, so the switch hears `/fail` rather than silence. The
    error is cut to 200 characters; `wrangler tail tela-jobs` shows it whole (`tick: a kind
    failed`). A schema the code does not match (a migration not applied) looks like this; so does
    a queue that refuses sends. It clears at the first tick that runs every kind.
  - *the last backup is from …* or *failed its check*: see *Backups*.
- **The Monday digest** to `DIGEST_TO`: new posts and members, how many blogs members added wait
  for review in Discover (with the link to `/admin/discover`, from `PUBLIC_URL`), failing and dead
  feeds, dead letters, model use, database size, the last backup, and feeds Cloudflare cannot
  reach (the case for the relay). Without `DIGEST_TO` or `RESEND_API_KEY` it is built and not sent;
  `wrangler tail tela-jobs` on a Monday at 08:00 UTC shows the run.
- **Resend's and Bailian's own consoles** for their quotas; the digest shows Tela's side of both.
- **Operator alerts** (ADR 0063): every fifth minute, beside the health check, tela-jobs mails
  `DIGEST_TO` (through `RESEND_API_KEY`) when something needs you before Monday's digest. With
  either unset, nothing is checked. Each mail carries only counts and console links.
  - **"Tela: 80% of today's translation budget used"**, or **"…budget is spent"**: today's tokens,
    everyone's together, reached that share of `translation.siteDailyTokens` (the shares are
    `alerts.budgetPercents`). Once a day per share; it resets at 00:00 UTC. Look at
    /admin/translation, or raise the budget under /admin/settings.
  - **"Tela: N new accounts today"**: more than `alerts.signupsPerDay` joined. If they look like
    spam, set `signup.mode` to `invite` (*Members and limits*); it applies at once.
  - **"Tela: N reports wait for a look"**: at most one an hour, and only when a report is new
    since the last. Review them at /admin/reports.

  A failed send is retried on the next run. What was sent: `select * from ops_alerts order by at
  desc`.

## The admin console

`/admin` (ADR 0039) is where the operator acts on what the digest and the dead-man's switch
report: claims to review, reports of public content (ADR 0059), feeds to fetch, pause or move to
the relay, the blogs members added and Discover's listings, members (suspend, delete), invite
codes, approved apps (ADR 0064), translation spend, dead letters, and the runtime settings (ADR
0056). It reads from
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
- **Blogrolls in Discover** (ADR 0050). A public blogroll reaches Discover's Blogrolls tab by
  itself once three of its blogs are shown to others (a blog the operator rejected is not shown).
  The Discover area's *Blogrolls* filter lists every public one, with its owner's handle, how many
  of its blogs others see and how many it has, and a status: *In Discover*, *Hidden* or *Fewer
  than three blogs*. Private blogrolls never appear.
  - **Hide from Discover** takes one out of the tab, and **Restore** puts it back; both are
    audited and undone like any other change. A hidden blogroll keeps its page (`/l/<id>`) and its
    place on its owner's profile. The owner is not told: `hidden_at` never syncs.
  - **Taking a page down** is not in the console yet. Until it is, hide the blogroll from Discover
    first (the console acts only on a public one, and a hidden blogroll stays hidden if its owner
    makes it public again), then make it private as its owner's own switch would, so their devices
    hear of it and a show from a stale device is refused (the id is the end of its address):

    ```sh
    wrangler d1 execute tela --remote --command "insert into counters (k, v) values ('seq', 1) on conflict (k) do update set v = v + 1; update blogrolls set is_public = 0, public_version = public_version + 1, seq = (select v from counters where k = 'seq') where id = '<id>'"
    ```

    The page is a 404 within minutes (the colo's five, then the browser's one). The owner can
    make it public again; only Discover stays closed to it.
- **Sign out everywhere** deletes the member's sessions; a device's signed copy of one still
  answers for up to five minutes wherever only that copy is read.
- **Retry** on a dead letter makes its row due again for the next tick, with fresh attempts. A body
  translation retried runs as background work: the background budget pays, reserving the whole
  spend of `LLM_MAX_ARTICLE_TOKENS` source tokens (about 2.9 tokens each, input and output: 115k
  at 40,000), and once the day's budget is spent the console refuses one until tomorrow. The health check counts only unresolved dead letters, and
  the digest says how many of the week's were resolved.
- **Heartbeats** (`ops_heartbeats`): `tick` (each kind dispatched, `errors` for each kind it
  could not run, and the switches tela-jobs runs with: the background budget, the article cap,
  whether a translator, the relay, WebSub and the assets bucket are configured), `health` (every fifth minute, what the dead-man's switch heard),
  `daily` (upkeep and the export) and `digest` (once sent). The console reads the budget and the
  relay from the tick's, so after a deploy they show as unknown until the first tick.
- **What it never shows:** a member's subscriptions, reading, likes, highlights, follows or
  private blogrolls, or who added a blog: the review queue shows how many read each blog, never who. An audit row never
  holds an email address.

## Backups

- **Time Travel** is the point-in-time copy: `wrangler d1 time-travel restore tela --timestamp=…`
  rolls the database back to any minute of the last 30 days. It restores in place; export first
  if the current state matters. **Then run `bun run admin closures`** at once: accounts closed
  since that minute come back with the rollback, and their closures in R2 close them again
  (ADR 0058). It is idempotent, and a request handles a few dozen closures; run it again until it
  reports none closed.
- **The nightly export** is the portable one. After the upkeep, every table worth keeping goes to
  `tela-content` under `backup/<date>/` as JSON lines (`<table>.<part>.jsonl`, 5,000 rows a part),
  with a `manifest.json` of row counts and SHA-256 hashes. A second pass reads it back to verify,
  and `backup/latest.json` records the result. Thirty days are kept. Sessions, sign-in codes,
  leases and limits are not exported: a restored database signs everyone in again. Nor are apps'
  tokens, spent refresh hashes and codes, or the day's opened posts (ADRs 0064, 0066): after a
  restore every connected app is refused (401, then `invalid_grant`) and its member connects it
  again. The apps and the connections come back, so Settings → Connected apps lists each one with
  no devices until it is connected again.
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
  3. **Close again the accounts closed since the backup** before the stack serves anyone: they
     come back with it. Each closing wrote `closures/<id>` (the id and when) to `tela-content`;
     `reapplyClosures(db, blobs, Date.now())` from `@tela/data` re-applies every one, idempotently
     (on the live stack, `bun run admin closures` does the same), and `member.erase` erases them
     again 10 minutes later (ADR 0058). Never delete `closures/`.
  4. Serve `createApp` (`apps/api/src/app.ts`) from any Hono runtime on `libsqlDb` and `s3Blobs`,
     run `runPortable` (`apps/jobs/src/portable.ts`) beside it for the sweeps, and serve the
     built SPA and `createEdge` (`apps/reader/worker/edge.ts`) in front. Every dependency is
     already an interface with a portable adapter.
- **The restore drill:** `bun run restore-drill` (`apps/api/scripts/restore-drill.ts`) takes the
  newest export (or `--date`) from R2 through `wrangler r2 object get --remote` (the deploy login,
  no S3 keys), restores it into a fresh, migrated libSQL file as step 2 does, and checks it: every
  table's count against the manifest, `pragma integrity_check` and `foreign_key_check`, the public
  pages' answers through `createApp`, and an admin's first sync. The scratch directory is deleted
  at the end (`--keep` keeps it): the export holds addresses and password hashes. Run it after a
  migration lands, and whenever the export changes.

  | Date | Export | Rows | Restore | Result |
  | --- | --- | --- | --- | --- |
  | 2026-10-25 | 2026-10-25 (migrations to 0013, restored under 0014) | 76,330 in 32 tables, 42 parts, 40 MB | download 91 s, restore 1.2 s | whole: counts, integrity and foreign keys clean; public pages 200; an admin's first sync |

## Members and limits

- **Runtime settings** (ADR 0056): `bun run admin settings` lists every one, what holds and its
  default; `bun run admin set <key> <value>` changes one (a number, `null` for no limit, a word,
  or JSON), audited like any console action, and the console's Settings area does the same with
  an undo. A setting holds from the next request: no deploy, no cache. `0` means nothing at all
  and `null` means no limit, so setting a budget to 0 stops spending, never unlimits it.
- **Sign-up:** `bun run admin set signup.mode open|invite`, or the console. A sheet shows the
  change within a minute (`/api/v1/public/auth` is cached 60 s); the gate enforces it at once.
  `signup.maxPerDay` (200) pauses joins without an invitation until 00:00 UTC; invitations and
  `bun run admin invite` are never capped, and every account made counts toward it. Spam: set
  `signup.mode invite`; members' invite codes work again at once.
- **Feeds and subscriptions** (ADR 0063): `member.feedsPerDay` (20) counts feeds new to Tela per
  UTC day (adding by URL, a claim, an import); subscribing to one Tela has is free.
  `member.maxSubscriptions` (300) caps subscriptions. Admins are exempt from both. Refusals are
  `429 feed_limit` and `409 subscription_limit`. An import's overflow waits in `pending_feeds`,
  and `member.pendingFeeds` adds it on the days after: `select user_id, count(*) from pending_feeds
  group by 1`. Raising the day or the cap lets the next tick move them.
- **Posts from blogs a member does not follow** (ADR 0066): `member.unsubscribedPostsPerDay`
  (100) counts the full posts a member opens per UTC day from blogs they do not subscribe to, on
  the web and in every app together. Only blogs they subscribe to are free: a blog they claimed
  counts like any other unless they subscribe to it. A post counts once a day however often it is
  fetched. Admins are exempt on the web and never through an app. A
  refusal is a 429 `post_limit` with `Retry-After`, and the reader shows the post's excerpt with
  *Subscribe to keep reading*. Who is near it: `select user_id, count(*) from post_opens where day
  = date('now') group by 1 order by 2 desc limit 10`. Lift one member early: `delete from
  post_opens where user_id = '<user id>' and day = date('now')`; the web edge keeps posts it
  already allowed until midnight UTC, so lowering the limit does not take back today's.
- **Deleting an account** (ADR 0058) is the member's own, from Settings › Account with a mailed
  code; an operator's `member.delete` (People) does the same to a spam account. Neither works on
  an admin: `bun run admin ungrant <email>` first. What others see goes in that batch; the rest
  goes within minutes (`member.erase`). The `user` and `profiles` rows stay for good as empty
  shells holding the handle. Caches keep a picture up to 30 days and a profile page a few
  minutes. Backups keep everything for their 30 days, which is why a restore runs
  `bun run admin closures`.
- **Releasing a blog:** its claimant does it from the Dashboard; the blog keeps its switches.
  An operator's Remove claim (Claims) also takes back the switches, since a false claimant could
  have set them.
- **Reports** (ADR 0059): members report a profile, blogroll, blog or note (20 a day each);
  visitors mail me@hutu.si. Work the queue at /admin/reports, one row per thing reported: act from
  its record (hide from Discover, suspend, delete), then Resolve; Dismiss when there is nothing to
  do. Both undo.
- **Suspension:** People › a member › Suspend ends their sessions and refuses sign-in, and their
  profile, notes and blogrolls leave every public page; cached pages linger up to 5 minutes per
  colo, pictures longer. Their body translations not yet started end, given back; their waiting
  imported feeds stay and arrive once it is lifted. Lift it from People › Suspended. An admin is
  never suspended.

## Apps members register

Third-party apps act for members through `api.telaread.com` (ADRs 0064, 0065). Any member
registers their own in Settings → Developer (ADR 0067); the operator reviews apps when their
developers ask, and handles reports of them. What a developer reads is `docs/api/` in this
repository.

- **Before announcing**, deploy the round and let a day pass: a shell cached before tela-web's
  deploy has no `/connect` or Settings → Developer until the tab reloads (its first sync is told
  to upgrade, which reloads it).
- **A member's app** starts in **Testing** (`draft`: only its developer connects it) and goes
  **Live** (`approved`) when its developer says so, once it has a privacy policy. Until reviewed it
  is shown as "Not reviewed by Tela" with its developer's handle, holds at most
  `apps.unreviewedMaxConnections` (100) members at once across that developer's unreviewed apps,
  and can't ask for the email address. A member holds at most `apps.perMember` (5) apps, and
  registers or edits at most 10 a day (`appRegister`). Neither the app's name nor its developer
  may say "Tela"; only the console's own registration can.
- **Reviews:** Members › Apps opens on *To review*, the apps whose developers asked, with their
  note and whether they want the email address. Read the privacy policy, try the app if it is
  cheap to, then **Review** (optionally granting email) or **Dismiss the request**; both undo. A
  review lifts the cap and the email ban. It covers the version you read: an edit since refuses it, and
  you look again. The developer changing anything members read (name, developer, homepage,
  privacy policy, redirect URIs, scope) clears it, and the app comes back to the queue when they
  ask again.
- **Reports of apps** land in Members › Reports with the app named and its developer as the
  member: **Cut off**, **End all connections**, or act on the developer's account (suspending them
  cuts off all their apps, until lifted). Only Live apps can be reported. A developer can't edit
  or delete an app that is cut off or has an open report.
- **Developer contacts**, for the preview's 14-day notice and any deprecation:
  `bun run admin app-contacts` lists the contact address of every Live app.
- **The operator's own registration** (Members › Apps › *Register app*) is for partners: the app
  is reviewed at once and may use "Tela" in its name. The form checks every field as tela-api
  will (`parseAppSettings`); the app starts in Testing with its `client_id` on the record, for
  its owner's account (the owner field; locked on a member's app, whose developer is its owner).
- **Approve** when the developer is ready: any member can connect it from then on. **Edit**
  changes the settings at any time; lowering what it may do, or taking the email away, reaches its
  live tokens at once. Its limits are requests a minute per member (120 when empty) and in all
  (6,000 when empty), and the members connected at once (no limit when empty); 0 is none. Each of
  these has an undo; an edit's undo puts back everything but the contact address, which an audit
  row never holds.
- **Cut off** (suspend) refuses every token the app holds on its next call: 403 `app_suspended`
  to its access tokens, `unauthorized_client` to its refresh tokens (both tell the app to keep
  them), and the consent page refuses it. Its images stop
  within a minute (the gateway's cache). Connections are kept, so **Restore** brings it back for
  the members who connected it; both undo. Write to the developer's contact address when you cut
  an app off, and why.
- **End all connections** ends every member's connection and every device's tokens, for good:
  each member has to connect it again. It is confirmed and has no undo; a member's grant is not
  the console's to give back. Use it after a leak of the app's tokens, or before deleting an app's
  last trace of access; cut off is the reversible stop.
- **Stop every app at once:** `bun run admin set apps.enabled off` (or the console's Settings).
  Every call is answered 503 `apps_paused` with `Retry-After: 300`, and the token endpoint too;
  connections and tokens are kept, and `on` resumes them. For an incident, not for one app.
- **A member's connections:** they see and disconnect them in Settings → Connected apps. The
  console's People › *Sign out everywhere* and *Suspend* end them in the same batch as the
  sessions, and the sign-out's history counts the connections it ended; so do a password set,
  changed or reset, a provider linked, the member's own sign out everywhere, and closing the
  account. The console never names who connected an app, only how many. By hand: `select a.name, g.scope, g.created_at, g.last_used_at
  from app_grants g join apps a on a.id = g.app_id where g.user_id = '<user id>' and g.ended_at is
  null`.
- **Rate limits** (`ACTION_LIMITS`): the app's own per member and in all, a minute each, counted
  when its token resolves (`appMember.<app id>:<user id>`, `appTotal:<app id>` in
  `action_limits`); the token endpoint, 30 a minute per app and IP (`appToken`); the consent
  page's answers, 30 an hour per member (`appConnect`). An app is held to every member limit as
  well, the operator's own account included: no app is ever exempt.
- **Deprecating an API version** (`docs/api/policy.md`): only v1 exists, in preview, where a
  breaking change needs 14 days' notice; once stable, the successor is announced 3 months before
  the old version is deprecated, which then answers for 12 months after its successor ships.
  1. Write to every app's contact: `select name, developer, contact_email from apps where status
     <> 'suspended'`.
  2. Add the change to `docs/api/CHANGELOG.md`.
  3. Set the version's `status` (`deprecated`) and `sunsetAt` in `API_VERSIONS`
     (`packages/shared/src/apps.ts`), which `/meta` reports, and deploy tela-api. The
     `Deprecation` and `Sunset` headers the policy promises are not sent yet: the first
     deprecation adds them, in tela-api's `/gateway` headers.
  4. A month and a week before `sunsetAt`, write again to the apps that still call it (Workers
     Logs, by path).
- **After a restore** (*Backups*): apps' tokens were not exported, so every app is refused and its
  members connect it again; nothing else is needed. The apps and their settings come back as
  they were.

## Search engines and AI

- **What is indexed** (ADR 0060): the landing page, Discover, the info pages, For writers, blogs
  an operator listed or curated, public blogrolls that Discover would list, and profiles of
  accounts in good standing at least 7 days old. Everything else says `noindex`. While
  `TELA_NOINDEX` is set, nothing is.
- **robots.txt** welcomes search engines and AI answer tools (OAI-SearchBot, ChatGPT-User,
  Claude-SearchBot, Claude-User, PerplexityBot…) on every public page, and lets AI training
  crawlers read only Tela's own copy (`/about`, `/privacy`, `/terms`, `/writers`, `/llms.txt`;
  not `/`, whose edition is writers' work): writers' titles and excerpts are not Tela's to give
  for training. It ends with
  `Content-Signal: search=yes, ai-input=yes, ai-train=no` and the sitemap.
- **Cloudflare's AI Crawl Control** can replace that file: keep "managed robots.txt" and "Block AI
  bots" off for telaread.com, and check with `curl -s https://telaread.com/robots.txt` after any
  change there.
- **Sitemaps:** `/sitemap.xml` indexes `/sitemap-{pages,sites,blogrolls,profiles}.xml`, each page
  under its four `?hl=` addresses and the bare one. A sitemap 503 means tela-api is not answering
  `/api/v1/public/sitemap`. `/llms.txt` describes Tela for AI tools.
- **Tela's own feeds** (ADR 0062): `/l/<id>.rss|.opml`, `/discover/articles.rss`, `/discover.opml`,
  each with an optional `?hl=` (and `?topic=` for Discover). Rendered at the edge from
  `/api/v1/public/feeds/*` through the colo cache, so a blogroll made private stops being served
  within about 6 minutes. They never trigger a translation. A 503 means tela-api failed.
- **Writers' pages** (ADR 0061): page fetches (extraction, a favicon's home page) read the origin's
  robots.txt, kept in `robots_rules` for a day (an hour when it was unreachable); feeds never do.
  A post refused this way shows `failed` with `extract_refused = 1` and keeps its excerpt; new
  rules on its origin make only those due again. To retry one by hand, delete its origin's
  `robots_rules` row and set the article `due`. A writer's "Only use what my feed
  provides" is `sites.feed_only`; an operator sets it from the blog's record.

## Launching

What opening Tela to everyone takes, in this order (ADRs 0056, 0060):

1. **Before:** deploy the round (*Provisioning*, step 7's public-launch notes) with `signup.mode` at
   `invite` and `TELA_NOINDEX` set. Verify telaread.com in Google Search Console and Bing Webmaster
   Tools (a DNS TXT record: the owner's), and Baidu if wanted. Check Cloudflare's AI Crawl Control
   as above. Read Privacy and Terms once more.
2. **Launch day:** `bun run admin set signup.mode open`; remove `TELA_NOINDEX` from
   `apps/reader/wrangler.jsonc` and deploy tela-web; submit `https://telaread.com/sitemap.xml` in
   both consoles; spot-check a `?hl=fr` page with Google's Rich Results Test.
3. **After:** the alerts mail the budget, sign-ups and reports. Spam sign-ups: `bun run admin set
   signup.mode invite`, which applies at once, and suspend or delete what got in.

Out of order, the site says the wrong thing: indexed while it still refuses everyone without an
invitation (step 2's deploy first), or admitting everyone while it tells search engines to stay
away (stopping before that deploy).

## Curation

Discover has three doors (ADR 0018): the editorial list, a verified claim, and three distinct
subscribers on an unclaimed site; and the operator reviews every blog a member adds (ADR 0041).
A public reader count is shown only from three readers.

- **Apply the editorial list:** `ADMIN_TOKEN=… bun run admin curate` adds each blog in
  `apps/api/scripts/curated-sites.ts` (fetched and parsed, so its declared home is honoured) and
  lists it with its topics, one blog a request. The few marked `featured: true` are featured,
  which puts them ahead of every other blog in Discover (ADR 0018, amended). Taking the mark off
  an entry and applying the list puts that blog back to listed; a blog removed from the list
  keeps its listing, so demote it in the console. An entry's `title` names a blog whose feed
  names it poorly ("feed - …", a bare address, none at all): no fetch rewrites a blog's name, and
  the reader shows it before the feed's. Running it again changes nothing that is already right.
  A rejected blog is left alone; a claimed one keeps its owner's topics and name.
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
- **Read a claim's method before believing it** (ADR 0045). *Meta tag* and *rel="me" link* are
  the blogger's own word on the page. *Link on every page* and *GitHub, both ways* are inferred: a
  link without `rel="me"` found on the home page and on the blog's 404 page, which shows its
  header, footer and sidebar and no post. Their known way to be wrong
  is someone the blog links from its header, footer or sidebar (a blogroll, a theme credit to a
  person, a sponsor slot) whose GitHub then names the blog. When a writer says their blog was
  taken, look at the method first; if it is one of those two, remove the claim and let the
  writer prove it with a meta tag. The removal holds: the claimant may ask again, and their claim
  then verifies only by the tag or `rel="me"`, not by the link you ruled on (`overruled_at`).
  Rejecting a claim does the same. Undoing the removal undoes that too.
- **A claim says "GitHub did not answer"** (`github_unavailable` in Evidence): GitHub refused or
  failed the lookup and nothing else on the page was proof. Without `GITHUB_TOKEN`, that is the
  shared 60-an-hour limit; with it, check the token has not expired (`curl -H "Authorization:
  Bearer …" https://api.github.com/rate_limit`).

## Translation

- **Spend:** `select * from usage_daily order by day desc limit 14` (subject `'*'` is background
  titles, `'~closed'` erased accounts' spend, kept so a closing gives no budget back, anything else
  a member), and per call `select job, model, count(*), sum(input_tokens), sum(output_tokens)
  from llm_calls where created_at > … group by job, model`. The digest has the
  week's totals. A call whose reply could not be read (no JSON, or not the schema) was still
  billed, so it is logged and charged like any other: a title job's to the background budget, a
  body's to what that translation has spent (`used_tokens`). A provider that keeps answering
  that way shows as `llm_calls` rows growing while `article_titles` does not, with the job
  retrying `reply contains no JSON object`. A call that timed out or never connected bills
  nothing Tela can see and is not logged.
- **Budgets and limits** (ADR 0057), all runtime settings (*Members and limits*):
  - `translation.siteDailyTokens` (10,000,000) is the day's model tokens, everyone's together,
    titles and bodies. Once spent, titles stop and new body requests wait for 00:00 UTC; bodies
    already running finish. An admin's own requests are never deferred by it, but count in it.
  - `translation.backgroundDailyTokens` caps titles inside it; null reads tela-jobs'
    `LLM_DAILY_BUDGET_TOKENS` (2,000,000 in production). Titles take the newest posts first, so an
    archive a newcomer imported never holds up today's titles.
  - `member.translationsPerDay` (20) counts the body translations a member's requests pay for. A
    post already translated for anyone, a conversion between the Chinese scripts (its own limit,
    `convert`, 600 an hour), one script of a post already translated into the other (the same,
    made from the cache) and a request that cost nothing do not count. Past it, a request waits
    for the next UTC day, one day deep, and a member with room today who opens a waiting post
    takes it over. The hourly `translate` bucket (30) still guards against a runaway client.
  - Pause titles: `bun run admin set translation.backgroundDailyTokens 0`. Stop paid bodies for
    members: `bun run admin set translation.siteDailyTokens 0` (operators still pass). `null`
    means no limit; `0` never does.
  - Day 2: waiting now, `select count(*), min(due_at) from body_translations where state =
    'requested' and due_at > unixepoch() * 1000`; the site today, `select coalesce(sum(used +
    reserved), 0) from usage_daily where day = date('now')`; members at their count, `select
    subject, requests from usage_daily where day = date('now') and subject not in ('*',
    '~closed') order by requests desc limit 20`; stuck after midnight, `select content_key, lang, due_at from
    body_translations where state in ('requested', 'running') and max(updated_at, coalesce(due_at,
    0)) < unixepoch() * 1000 - 1800000`. At 00:00 UTC the waiting bodies start, 20 a minute: watch
    the stuck check on the first nights.
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
  pre-authentication limit). A feed fetched from Cloudflare is read up to 10 MB, but one routed
  through the relay stops at the relay's 5 MB and fails as `too_large`.

## Later

- **Restore into a fresh D1**, as the restore drill does into libSQL: `restoreDatabase` turns
  foreign keys off with a pragma D1 may ignore, and sends 200 rows a statement in one JSON
  parameter, which D1's statement size may refuse for wide tables.
- **The next Node LTS**, for the relay only, **after 2026-10-28**, when Node 26 reaches LTS; Node 24 <!-- node-pin:planned -->
  enters maintenance on 2026-10-20, so the two dates make one clean move. Five pins change <!-- node-pin:planned -->
  together: `.node-version`, `engines`, the relay Dockerfile's runtime stage, the CI
  `node-version` and `@types/node`, plus the Node major the living docs name. `test/docs.test.ts`
  fails until they all agree.
- **China checks** from a mainland connection once readers there are invited: the first sync, and
  images from hosts like `mmbiz.qpic.cn`.
