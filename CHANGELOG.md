# Changelog

Notable, release-worthy changes to Tela. The fine-grained history lives in the git log
(Conventional Commits, with the reasoning in the bodies); this file records milestones. Format
follows [Keep a Changelog](https://keepachangelog.com/). Tela has not cut a release yet, so
everything so far sits under `[Unreleased]`.

## [Unreleased]

### Changed

- **The local-first stack.** Tela moved all-in onto Cloudflare — three Workers, D1, R2, Queues
  and Cron — and Fly, Supabase, Hyperdrive, Next.js and pg-boss went (ADR 0020).
  - **The reader renders from the device.** Every screen reads the rows the browser holds in
    IndexedDB, and a seq-cursor sync keeps them current behind it. After the first sync, opening
    posts, changing filters and going back make no request at all, which is what makes reading
    instant from mainland China without a mainland CDN (ADR 0025).
  - **Bodies are immutable versions**, stored as render-ready objects and cached forever at the
    edge and on the device, which also fixed a summary overwriting an extracted full text (ADR 0022).
  - **Translation streams:** the first paragraphs of a foreign post arrive in about five seconds,
    and titles are translated a feed at a time, which cut their cost to a fraction (ADR 0023).
  - **Background work is state under leases**, so a lost message costs nothing, one feed is never
    fetched twice at once, and a job killed by its limit cannot retry for ever.
  - **Sign-in is an emailed code** through better-auth; the mail's link works on any device
    (ADR 0024).
  - **Portable by construction:** every binding sits behind an interface with a portable
    adapter, and the suite runs on them (ADR 0021).

### Added

- **Highlights and notes**, private, on either side of a translation, and found again when the
  post is edited; text size, line length and a dark theme, synced across devices; `j`/`k`, `Esc`
  and `h` on the reading page (ADR 0026).
- **A quieter reading page:** the sidebar hides (`[`, or the toggle at the head of the list), and
  the choice is this device's rather than synced (ADR 0029), which on a laptop window is what
  makes room for the two bilingual columns. The article column is centred in the pane, and an
  *Up next* card at the end of a post offers the one after it.

- **Running unattended.** A dead-man's switch pinged by the sweeps while they are healthy, a
  Monday digest to the owner, and a nightly export verified against its manifest, which the suite
  restores into a fresh database and serves from on every run (ADR 0027).

- **Milestone 1 — the reader.** Subscribe by URL or OPML; unread counts kept by a watermark on
  ingest order rather than a row per article per reader (ADR 0009); filters for all, today and
  liked; mark read and mark all read; likes. The reading view is three columns on wide screens and
  a stacked list-then-article fallback below `lg`, which `mobile.e2e.ts` keeps working.

- **Translation, aligned block by block.** Titles translate eagerly, bodies lazily on first open,
  so a reader never pays for a post they do not read. Article bodies are sanitized to an allowlist
  and normalized so every text-bearing element is a leaf block; each leaf's inline content becomes
  XLIFF-style tagged text, and its id is a hash of that text plus `NORM_VERSION`. Translations are
  cached against that hash, so a recurring footer is translated once across every article that
  carries it, and an edit costs only the blocks that changed (ADR 0005). Side by side, translation
  and original modes line the two up block for block: one grid row per top-level block, original
  first, so the two cannot drift apart — collapsing to a source-then-translation interleave when
  the pane is too narrow for two columns, with nothing changing places at the threshold
  (ADR 0019). A paragraph the translator could not do says so instead of
  passing its source text off as a translation. Providers are pluggable — Aliyun Bailian GLM
  first, Anthropic second, a mock for tests (ADR 0006).

- **Discover, and claiming your feed.** Listed blogs with topic and language filters, site pages,
  and subscribe from a card. A blogger proves ownership with a meta tag or a `rel="me"` link;
  claimed sites are listed, and can opt out of translation entirely (ADR 0011).

- **Three doors into Discover.** A claim gate alone left the directory empty until the first
  blogger claimed a site, which reads as a broken page rather than an empty one. An editorial list
  of independent blogs now seeds it — checked into `apps/api/scripts/curated-sites.ts` and
  applied by `bun run admin curate` — and an unclaimed site lists itself once three distinct
  members subscribe to it. Three, not one: at one, the directory would republish a single member's
  reading list (ADR 0018).

- **Recommendations and profiles.** Recommend a post with a note; the note appears on your public
  profile at `/@handle` and in the author's dashboard, beside likes and reader counts. Settings
  cover handle, display name, bio, public subscriptions, reading language and OPML export.

- **Search across blogs and your subscriptions**, by original or translated title, on trigram
  indexes so it works for CJK as well as Latin scripts.

- **Freshness without polling harder than necessary.** Adaptive intervals with conditional
  requests, plus WebSub push where a feed advertises a hub. A hub ping only enqueues a fetch, so a
  misbehaving hub cannot inject content.

- **Reachability from mainland China.** Feeds that keep timing out are re-fetched through a signed
  relay on a Hong Kong or mainland box and re-probed directly a week later; a feed that times out
  three more times flips back on its own. The relay is not an open proxy: signed `POST /fetch`
  only, private ranges refused, no redirects followed, upstream body capped (ADR 0008).

- **Operational visibility.** A five-minute health check logs per-queue depth, dead letters,
  failure counts and overdue feeds, and warns on any of them; `/api/health` covers the web app and
  reports database latency and the failure reason.

- **English and Simplified Chinese throughout**, switchable without a page reload, with no locale
  prefix in the URL (ADR 0010).

- **Private testing.** Signup is closed at the platform level and the site is kept out of search
  indexes while `TELA_PRIVATE_BETA` is set; the way in is an admin invite. Invite codes were
  deliberately not built — their design should follow the decision about how to open up
  (ADR 0015).

- **A logo.** Two mirrored strands crossing at the centre, in the header beside the wordmark and
  on a dark tile as the favicon and app icon — until now browser tabs showed the stock Next.js
  mark. The tile's strands thicken as it shrinks so the crossing survives 16px.

### Changed

- **Side by side is a container query on the reader pane, and the reader's choice is remembered.**
  Two columns used to appear at a 1280px viewport, where the pane — the third cell of a
  `220px 260px 1fr` grid — leaves 348px per column, about 32 characters. They now wait until each
  column can hold 640px, and below that the pairs interleave at full measure. The display mode
  survives closing an article, so translation-only no longer has to be re-picked every time
  (ADR 0019).

- **Opening an article after the first render does not render the page again.** It had been up to
  five renders of the whole three-pane page, then ADR 0016 reduced that to one database wave and one
  render. Production CPU measurements showed even that render was too costly for Workers Free.
  Article links now keep their normal browser behavior while ordinary clicks fetch an authenticated
  JSON pane; Back, Forward, translation completion, and full-text extraction replace only that pane.
  Direct links remain server-rendered, and the URL remains the source of truth (ADRs 0016, 0017).

- **Tela serves from `tela.ainaive.com`, and `workers.dev` is off.** The `workers.dev` address is
  blocked in mainland China, so it is a dead link for part of the audience; a custom-domain route
  without an explicit `workers_dev` setting turns it off, which is the intended end state.

- **Auth mail goes through Resend, 30 an hour.** Supabase's built-in sender allows two an hour,
  which no real sign-in traffic fits. The mail now carries the six-digit code first and a link
  below it that points at `/auth/callback` with a token hash — so it works from any browser, where
  a PKCE code needs the verifier cookie of the browser that asked (ADR 0013).

- **Supabase settings are code.** `supabase/config.toml` is the source of truth for everything
  `supabase config push` manages; the Dashboard is a mirror the next push overwrites (ADR 0014).

- **The worker runs on Node 24 LTS, built with Bun 1.4.** Five pins have to agree for that to mean
  anything — `.node-version`, `engines`, the Dockerfile's runtime stage, the CI `node-version`, and
  `@types/node` — and a test now holds them together, along with the Node major the living docs
  name. `@types/node` had drifted to 26 against a Node 22 runtime, which typechecks APIs the
  deployed runtime does not have (ADR 0001).

- **Toolchain and dependencies moved to current majors.** TypeScript 7 — the native compiler,
  which cuts Next's typecheck from 3.3s to under a second — and undici 8 under the worker's
  DNS-pinned fetch. Every GitHub Action moved to its current major. `NORM_VERSION` stays at 1;
  nothing here touches block normalization, so the translation cache survives.

  The htmlparser2 family stays where it was. Moving it to htmlparser2 12 and its ESM-only
  siblings made `sanitize-html` — which is CommonJS and `require`s htmlparser2 — fail to load
  under the Bun test runner, intermittently and depending on which module the process reached
  first. Production was never at risk (the worker runs on Node, which handles `require(esm)`), but
  a test suite that fails on one run in several is not worth what the upgrade bought: our own
  parsing matching the version `sanitize-html` already used. It never deduplicated the tree —
  `linkedom` pins `htmlparser2@^10.1` regardless.

- **The session pooler is the database path** for Hyperdrive, the worker and migrations: it has
  IPv4 and keeps prepared statements. Supabase's paid IPv4 add-on stays off, and the runbook names
  the symptom that would justify buying it.

### Fixed

- **Members could not sign in at all.** Closing signup for private testing set
  `enable_signup = false` under both `[auth]` and `[auth.email]` in `supabase/config.toml`. The
  second is not a signup switch — the CLI maps it to GoTrue's `EXTERNAL_EMAIL_ENABLED` — so it
  disabled email sign-in for everyone, and with GitHub and Google unconfigured that was every way
  in. The login form then reported it as "this address does not have an account yet", because it
  chose that message from the HTTP status and GoTrue answers 422 both for an unknown address and
  for a disabled provider. The provider is back on, registration stays closed by `[auth]` alone,
  and the message now comes from the error code with the no-account case reserved to
  `otp_disabled` (ADR 0015).

- **A request has one deadline, spanning redirects and politeness waits.** The abort signal was
  built inside the redirect loop, so every hop got the full timeout again: a request configured
  for 100 ms was observed succeeding after about 500 ms through five redirects.

- **Body translations carry an attempt shared by worker, scheduler and web.** Deduplication by
  article and language meant a second reader's request got no job, while the first job metered its
  usage against the first reader and wrote its status onto the second reader's row; rows that lost
  their job stayed running forever, holding a reservation. Every write is now a compare-and-set on
  the attempt id, each provider call has an abort deadline, and each execution a budget shorter
  than its pg-boss lease — so no execution can overlap its own retry and pay twice.

- **Translations survive a reply that is not valid JSON.** GLM copied straight quotes into the
  translated text unescaped, which invalidated the whole reply and made the job retry into the
  same reply; a first real run translated 50 titles and failed 10. Entries are now recovered one
  at a time by id when the reply as a whole will not parse.

- **The translation cache is keyed by source language as well as target**, so two source languages
  that produce the same normalized text cannot collide.

- **A queue's policy change is loud.** `ensureQueues` no longer sends policy to existing queues;
  a code change that alters one stops the worker with an explanation instead of silently
  diverging.

- **Extraction is retried when it fails transiently** rather than recorded as final, runs on a
  cooldown window rather than on every render, and covers short articles from feeds too small to
  classify. A fetch processes at most the newest 200 items.

- **A site is keyed by the home its feed declares**, not by the feed's host, and a declared home
  can never attach a feed to another member's site.

- **An active blog is no longer polled as if it had gone quiet.** The fetch interval is stored
  with its ±10% jitter applied and read back as the input to the next backoff, so the jitter
  compounded on every step and the column ratcheted past the 24h ceiling it is clamped to — four
  production feeds sat between 88 540 s and 93 028 s. The jitter now moves only `next_fetch_at`,
  which is what it is for: spreading feeds that were fetched together.

- **A feed seeded by hand gets its title translations.** `worker:once fetch` called `fetchFeed`
  with no options, and `onArticleStored` is the only thing that queues `translate.title` — so
  every article of the four feeds seeded that way was left untranslatable, with nothing to retry.
  Fresh databases still ingest before pg-boss exists, and `worker:once repair-titles` safely
  queues the missing work once the worker has created its queues.

- **A title that translates to itself is kept, not thrown away.** Validation refuses a block the
  model echoes back, which is right for prose and wrong for a package name or a version string.
  The rejection was also silent: no row, no dead letter, no retry, so the post kept its original
  title indefinitely under a badge announcing a translated one. Title blocks now allow an echo;
  excerpts and bodies keep the safeguard so prose cannot poison their shared cache. Reading and
  search badges appear only over a title we actually hold. An echo accepted that way is kept out of the shared
  block cache, which is content-addressed and first-write-wins: a body heading repeating the
  headline hashes identically and would have inherited that judgement permanently.

- **A Traditional Chinese post says so when it is shown in Simplified.** The list badge compared
  primary subtags, making it the only place in the codebase that treated `zh-Hant` and `zh-Hans`
  as one language — the worker translates the pair, the cache namespaces them apart, and the
  article pane already named both — so a converted title appeared with nothing to indicate it.

- **Title recovery is one statement.** `worker:once repair-titles` looped an insert per job, up to
  5,000 round trips for one batch. It now hands its candidate select to the job sender, which
  evaluates the in-flight exclusion against the snapshot it inserts from.

- **Tablet-width windows had no navigation.** The header turned on the wordmark and a fixed 240px
  search field together at `md`, which cost more width than 768px had; the nav was the only item
  that could absorb it and rendered 4px wide, leaving no way to reach Dashboard or Settings between
  768px and roughly 1100px. The controls now arrive across `lg` and `xl`, search collapses to a
  link below `xl` rather than a field that crowds the nav out, and the full nav is present from
  800px. The search page carries the input itself below `xl`, so that link leads somewhere a query
  can be typed. `styles.e2e.ts` measures the header at 640, 768, 800, 1024 and 1280.

- **The chrome said one thing and rendered another.** The `a` rules in `globals.css` sat outside
  any cascade layer, and an unlayered declaration outranks every layered one — including
  `@layer utilities`, where Tailwind v4 puts everything. Thirty `hover:no-underline` and every
  `text-ink` on a link were dead code, so the wordmark, the nav pills, article titles and sidebar
  rows all rendered accent green and underlined on hover while the class strings read correctly.
  Base element styles now live in `@layer base`, and `styles.e2e.ts` asserts the computed values.

### Security

- **One browser, one account at a time.** Every tab shares the session cookie and the device's
  database, so a tab still showing one account could act for the one another tab signed into:
  apply its unsent changes, write its rows into that account's copy, subscribe, save a profile,
  or verify a blog claim. Every member call now names the member and tela-api refuses a
  mismatch; every write to the device's copy checks its owner in the same transaction; a stale
  tab starts over. Protocol 2: older cached shells are told to upgrade (ADR 0025).
- **Outbound fetches are pinned to vetted addresses.** The worker resolves every host itself and
  refuses names that resolve into a private range, DNS-pinned through undici so the address that
  passed the check is the address that is dialled. Byte caps are enforced while bytes arrive, not
  after; relay requests larger than 64 KiB are refused before they are read, which is the only
  pre-authentication limit because the signature covers the body.

- **The Supabase Data API is off.** While it is on, `public` is always among the exposed schemas,
  which would publish every table to the anon key. It had been switched off in the Dashboard and
  turned back on by an unrelated `supabase config push`, since the file still said otherwise
  (ADR 0014).

- **Every RLS policy is read-only, and private sites are hidden from anon.** There is no
  client-side write path, so nothing reachable with the anon key can skip the invariants
  application code enforces.

- **Translation spend is metered per member**, with an allowance reserved when a reader asks, in a
  service-role-only table; the daily budget re-queues background title jobs rather than
  overrunning, and what rides along in a prompt is bounded.

- **One `safeNext` guard for every user-supplied redirect target**, and Supabase sessions refresh
  in middleware — never only inside a Server Component, which cannot write the rotated cookies
  back.

- **A verified claim cannot be taken over by a later verifier**, and a claimed site carries only
  the feeds it vouches for.
