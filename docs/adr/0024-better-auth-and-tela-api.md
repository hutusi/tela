# 0024 — Sign-in with better-auth on tela-api, through the same Db seam as everything else

Status: accepted (2026-09-28). Supersedes 0012 (Supabase providers and dev-auth), 0013's
mechanism (its rule stands: the mail carries the code) and 0014 (Supabase settings as code); the
old ADRs' status lines change at cutover. 0015's policy stands: registration stays closed and the
site stays hidden from crawlers, with the mechanism below. Amended by 0034 and 0036 (2026-10-02):
an account is created at its first sign-in for an address that holds an invitation (a member's
code, an operator's code or `admin invite`), checked by one gate in `user.create.before` (0034);
and passwords, Google and GitHub join the email code (0036), superseding "Email codes only" and
"OAuth is deferred". The rest stands.

## Context

ADR 0020 removes Supabase, and with it GoTrue. Sign-in has to run on Cloudflare with D1 and still
leave the exit path of ADR 0021 intact: Node, libSQL and a timer, with the test suite running on
that path.

Spike S4 ran better-auth 1.7.6 on D1 through its native driver and measured what it costs:

- about 18 statements per sign-in;
- about 3 round trips per new instance for runtime schema validation, unless it is turned off;
- one shared rate-limit bucket for every visitor unless it reads `cf-connecting-ip`.

Delivery through Resend reached the inbox at qq.com and 163.com.

What the Postgres stack's sign-in did, from surveying `apps/web`:

- email codes (with a link carrying the same code, ADR 0013);
- GitHub and Google buttons whose OAuth apps were never configured;
- a dev-auth mode for local runs;
- invites from the Supabase dashboard.

## Decision

- **better-auth 1.7.6 in tela-api, through its Drizzle adapter over `TelaDb`**, not its native D1
  driver.
  - Every `transaction()` call in the adapter is on its MySQL path. On SQLite it writes with
    `returning()` and consumes a code with one atomic `delete … returning`, which D1 and libSQL
    both run.
  - So sign-in goes through the one `Db` seam. It runs on libSQL in the test suite and on the exit
    path, and the auth tables live in the one migration (mirrored from `auth generate`: snake_case,
    epoch-millisecond dates).
  - Measured on the portable path: 18 statements per sign-in, the same as S4's native driver. For
    Drizzle, `validateSchema` only inspects the schema object and opens no connection, so it stays
    on and catches drift for free.
- **Email codes only.** Six digits, one hour, three attempts, stored hashed. Registration is
  closed (`disableSignUp`): an unknown address gets the same answer as a known one and no mail.
  - The mail leads with the code in both UI languages. Its link, `/login?email=…&otp=…`, submits
    the same code, so it signs in whichever device opens it.
  - An invited member's first mail says they are invited.
- **OAuth is deferred.** Its apps were never configured on the old stack. better-auth adds a
  provider with a few lines when one is wanted.
- **Dev-auth is dropped.** Tests and e2e sign in through the real code flow. They read the code
  from the memory outbox, or from `/api/test/outbox`, which exists only when `ENV=test`.
- **Invites** are `POST /api/admin/invite` with `Bearer ADMIN_TOKEN`. `bun run admin invite
  <email>` calls it, so D1 credentials never leave Cloudflare. A database hook creates the
  member's profile (handle `u_` and ten hex digits) in the step that creates the account, as the
  Postgres trigger did.
- **Sessions** last 60 days and are refreshed daily.
  - A signed copy rides in a cookie (`tela.session_data`, better-auth's compact HMAC-SHA256 form)
    for five minutes. tela-api reads no session row while it is valid, and tela-web can authorize
    content objects without D1 at all.
  - Cookies are prefixed `tela.`, `SameSite=Lax`, and `Secure` on the https origin.
    `trustedOrigins` is the public URL.
- **Rate limits** are better-auth's own, stored in D1 (`rate_limit`), because per-isolate memory
  is useless on Workers.
  - The client address is `cf-connecting-ip`. The sign-in endpoint allows three tries a minute per
    address, beside the three attempts per code.
  - Tela's own action limits are a separate table, `action_limits`.
- **Private beta** (ADR 0015): registration is closed by `disableSignUp` and the invite route.
  The crawler rule moves to tela-web (robots and `X-Robots-Tag`) while `TELA_PRIVATE_BETA` is set.

**tela-api itself** is a Hono app built from portable dependencies (`createApp(deps)`):

- The Cloudflare entry, `src/worker.ts`, builds those dependencies from bindings once per isolate.
  The bun route suite builds them on libSQL, memory mail, blobs and queues.
- It is pinned to `aws:ap-southeast-1` beside the D1 primary and has no public route. tela-web
  forwards `/api/*` to it over a service binding.

**Asking for a body translation** (`POST /api/v1/translations`, ADR 0023's reservation) is an RPC,
because the reader needs the answer.
- It checks in this order:
  1. the blog's translation opt-out, **before** anything is counted or reserved (the Postgres app
     spent the member's limit and allowance first);
  2. whether a translation already exists or is running;
  3. the member's hourly limit.
- Then one batch writes the `requested` row and its reservation, both conditional. The row is
  written only while the day's `used + reserved` leaves room under 400k tokens and no
  translation is running. The reservation is written only for that row.
- The estimate leans high (1.5× the body's source tokens, plus 500), because the reservation is
  also the job's ceiling. A low guess would cut the translation short, while a high one is given
  back when the job reconciles what it spent.
- The route claims the work and queues it at once, so the first chunk does not wait for the next
  sweep.
- `GET /api/v1/translations/:contentKey/:lang` is what the reader polls while chunks stream in.
  It never says who asked or what it cost.

**Work that fetches runs in tela-jobs**, behind its `Ingest` entrypoint on the `JOBS` service
binding: discovery, adding a feed by URL, starting a claim, and reading OPML.
- tela-api never bundles linkedom, the feed parsers or the DNS-pinned client. Parsing OPML in
  tela-api cost 154 KB gzipped for feedsmith alone.
- A feed added by URL is fetched and parsed before it becomes a row. The Postgres app took any
  http(s) URL a hidden form field carried.
- A new feed is claimed and queued at once, so its first posts arrive in seconds.
- An OPML import registers up to 500 feeds in three statements without fetching, under
  placeholder sites keyed by origin. The sweeps fetch them, per host, within the minute.

**Public reads** (`/api/v1/public/discover`, `/sites/:id`, `/profiles/:handle`) need no
session. They are JSON with `s-maxage=300` and a day of stale-while-revalidate (a profile, four
minutes: 0031); tela-web renders them into pages with the reader's own components (Phase 6).
- They show listed and featured blogs only. The Postgres app rendered a private or rejected
  site's page for anyone who knew its id, which on a cached public page would be a leak.
- A profile's subscriptions appear only when the member turned that on. Private blogs among them
  are named, since the member chose to show them, but get no page link.

**Claims** derive their token rather than store it: an HMAC of the site and member under the auth
secret.
- It is stable across devices, and nothing exists until the member asks for the check.
- A row made when the member started would be `pending`, which is what the verify sweep claims,
  so it would be checked before the token could be on the page.

## Consequences

- **Signing out is not instant everywhere.** The signed session cache stays valid for up to five
  minutes after sign-out, on a device that kept a copy of the cookie. The browser that signs out
  drops it at once. That is the price of zero session reads; sensitive actions can ask for a
  fresh read.
- **Sign-in costs about 150 ms** of D1 round trips from the pinned Worker (18 at 6–10 ms), and
  an authenticated request none while the cache is valid.
- **Tests caught two ways a sign-in suite can lie.** A test of the three-attempt rule passed with
  the rule loosened to ten, because the per-address rate limit refused the fourth try first. The
  suite now sends each try from its own address, and tests the rate limit on its own. Both fail
  when their rule is loosened.
- **An upgrade of better-auth** regenerates the auth schema with `bunx auth@<version> generate`
  and compares it with `packages/data/src/schema/auth.ts`.
