# 0012 — Auth: email code, GitHub, Google via Supabase; dev-auth mode for local runs

Status: accepted (2026-09-04)

## Context

Readers in mainland China cannot reach Google; GitHub is reachable but slow; WeChat login needs a
registered company. Supabase Auth's built-in mailer allows two emails per hour. Local development
and end-to-end tests need to sign in without a Supabase project or Docker.

## Decision

- Providers: email one-time code (custom SMTP via Resend, deliverability to qq.com/163.com must
  be tested), GitHub, Google. No passwords. WeChat is out of scope.
- Sessions live in Supabase cookies managed by `@supabase/ssr`; server code verifies the JWT
  locally with `auth.getClaims()` instead of a network round trip per request.
- `profiles` rows are created by the database trigger on `auth.users`, so every session has a
  profile.
- **Dev-auth mode**: with `TELA_DEV_AUTH=1` every request is the fixed development user
  (`00000000-0000-4000-8000-000000000001`, created by `bun run db:local`). The switch is refused
  whenever the Cloudflare runtime is detected, so it cannot be enabled in a deployment. The
  e2e suite and local `next start` runs use it.

## Consequences

- No Supabase project is needed to develop or test the reader; auth flows themselves are
  exercised against a real project before launch (verify gate).
- Google sign-in appears for everyone but fails for readers behind the Great Firewall; the email
  code path is the documented fallback.
