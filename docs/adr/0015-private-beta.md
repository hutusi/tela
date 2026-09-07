# 0015 — Private beta: signup closed at the platform level, the site hidden from crawlers

Status: accepted (2026-09-06). Amended 2026-09-07: the decision stands, its mechanism was wrong.
`enable_signup = false` under `[auth.email]` is the email *provider* switch, and setting it there
locked every existing member out of the live site; only `[auth]` closes registration.

## Context

Tela is deployed and works, and it is worth improving before anyone else can join. But the login
page created an account for any address that reached it, so the site was open the moment it had a
domain. The domain is also new: nothing should index a half-finished site under it and fix that
impression in search results.

The obvious mechanism is invite codes. Their design, though, depends on how Tela decides to open
up — one-at-a-time invitations, waitlist batches, or open signup with rate limits are three
different features — and building the wrong one now means removing it later.

## Decision

- **Signup is closed at the platform level**, not in application code: `enable_signup = false`
  under `[auth]` in `supabase/config.toml`, pushed, so a Dashboard change cannot drift it back
  open (ADR 0014). **Under `[auth]` only.** The identically named key under `[auth.email]` is not
  a signup switch: the CLI maps it to GoTrue's `EXTERNAL_EMAIL_ENABLED`, so setting it `false`
  turns off email sign-in for everyone, existing accounts included. It must stay `true`.
- **The way in is an admin invite**, which still works with signup off. Its mail gets a template
  like the sign-in ones, with a code and a link to `/auth/callback` that the callback already
  accepts as `type=invite` (ADR 0013).
- The login form passes `shouldCreateUser: false`, which is what makes GoTrue refuse an unknown
  address (`otp_disabled`) whatever the project settings say, and tells it that Tela is in private
  testing rather than failing opaquely. That message is chosen from the error *code*, never the
  HTTP status: 422 covers several unrelated causes, and only `otp_disabled` means "no account"
  (`apps/web/src/lib/login-error.ts`).
- **The site is hidden from crawlers** while `TELA_PRIVATE_BETA` is set in
  `apps/web/wrangler.jsonc`: `robots.txt` disallows every crawler and pages carry a `noindex` tag.
- **Invite codes are deliberately not built.** Their design follows the decision about how to open
  up, and that decision has not been made.

## Consequences

- Closing signup is one setting rather than a feature, so opening up is one setting too:
  `enable_signup = true` plus a push, then removing `TELA_PRIVATE_BETA` from the wrangler config
  plus a deploy. The runbook says so under "Later".
- Two switches must both be thrown to open up. Throwing only the first leaves a site that accepts
  members but tells search engines to ignore it.
- Adding a tester is a manual admin action. That is the intended cost at this size.
- Email is currently the only way in — GitHub and Google are not configured — so the email
  provider is a single point of failure for every member. Disabling it took the whole site down
  for a day without any alert firing, because a locked-out member looks identical to a healthy
  site from the outside. `GET /auth/v1/settings` reports `external.email` and `disable_signup`
  with the anon key alone, and is the cheapest way to see the real state.
- Alternatives considered: an allow-list of email addresses in application code (a second place
  for signup policy to live, and it would not stop Supabase creating the user); invite codes
  (premature, per above); leaving signup open and relying on obscurity (the domain is public in
  certificate transparency logs the moment it is issued).
