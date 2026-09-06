# 0014 — Supabase settings are code, and the Data API stays off

Status: accepted (2026-09-06)

## Context

Supabase exposes the same settings in two places: the Dashboard and `supabase/config.toml`. The
runbook said the Data API could only be switched off in the Dashboard, because `api.enabled` was
believed to be local-only. It is not. The owner switched the Data API off in the Dashboard, and
the next `supabase config push` — sent for an unrelated SMTP change — reported the API service
updated and turned it back on, because the file still said `enabled = true`. Verified from
outside with the anon key: rows before, an error after the fix.

Any setting that `push` manages will silently revert to whatever the file says, on the next push
for any reason. A Dashboard change is therefore not a decision; it is a value with a countdown.

## Decision

- **`supabase/config.toml` is the source of truth** for everything `supabase config push` manages:
  the API, auth providers, SMTP, rate limits, redirect allow-list, email templates. The Dashboard
  is a mirror, and a change made there survives only until the next push.
- Settings that matter carry a comment in the file saying *why* they hold that value, so the next
  reader does not restore a default.
- **The Data API is off** (`[api] enabled = false`). Nothing in the app uses it: every query goes
  through Postgres via Drizzle, and supabase-js is used only for Auth in the browser. While the
  Data API is on, `public` is always among the exposed schemas, so leaving it on would publish
  every table to the anon key and make RLS the only thing standing between a reader and the
  data.
- RLS stays enabled and read-only regardless (ADR 0003). It is the backstop, not the authority.

## Consequences

- The auth configuration is reviewable in a diff and reproducible on a fresh project.
- A setting changed in the Dashboard and not in the file is a bug with a delayed fuse; the runbook
  names the file as the source of truth so the fix is to edit and push.
- Turning the Data API back on would need a deliberate decision about which schemas it exposes,
  not a toggle.
- Alternatives considered: managing the project from the Dashboard and treating the file as local
  development config (this is what caused the incident); a `push`-time diff check (Supabase does
  not offer one, and the comments in the file are cheaper).
