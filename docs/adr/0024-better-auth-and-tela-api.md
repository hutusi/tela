# 0024 — Sign-in with better-auth on tela-api, through the same Db seam as everything else

Status: accepted (2026-09-28). Supersedes 0012 (Supabase providers and dev-auth), 0013's
mechanism (its rule stands: the mail carries the code) and 0014 (Supabase settings as code); the
old ADRs' status lines change at cutover. 0015's policy stands: registration stays closed and the
site stays hidden from crawlers, with the mechanism below.

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
