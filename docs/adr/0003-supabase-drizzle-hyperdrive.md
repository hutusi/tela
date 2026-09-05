# 0003 — Supabase Postgres + Auth, Drizzle everywhere, Hyperdrive to the session pooler

Status: accepted (2026-09-04)

## Context

Tela needs Postgres, multi-provider auth, and a typed query layer usable from both the Cloudflare
Worker and the Node worker. Supabase provides Postgres, Auth, and Storage in one place with APAC
regions. Cloudflare's guidance for Supabase is to point Hyperdrive at the direct connection, not the
Supavisor transaction pooler (which also disables prepared statements). The direct host is
IPv6-only, which Hyperdrive cannot reach, and Supabase charges for an IPv4 address.

## Decision

- Supabase project in Tokyo (`ap-northeast-1`). Hyperdrive, the worker, and migrations use the
  Supavisor *session* pooler: it has IPv4 and keeps prepared statements. The paid IPv4 add-on and
  the direct connection are an optional upgrade for when the session pool runs out and raising
  its size is not enough (decided 2026-09-05; `docs/OPERATIONS.md` has the symptom to watch).
- Drizzle ORM + postgres.js for all server code (web and worker). supabase-js only in the browser
  for Auth (and Realtime later). Migrations via `drizzle-kit generate`, never `push` (which has
  skipped policies in a known bug); custom SQL in `--custom` migrations.
- RLS enabled on every table and declared in the schema with `pgPolicy`. App code on the service
  connection is the authority; RLS is the backstop for the anon key path. Policies only grant
  reads (members see everything, anonymous callers only listed sites): there is no client-side
  write path, so nothing reachable with the anon key can skip the invariants application code
  enforces (denormalized counters, rate limits, reserved handles, `is_admin`).
- `profiles` rows are created by a `security definer` trigger on `auth.users`.
- Custom SMTP (Resend) from day one: the built-in mailer allows 2 emails/hour.

## Consequences

- One query language and one set of types across web and worker; complex reads (unread counts,
  anti-joins) stay in SQL rather than PostgREST RPCs.
- Tests need a Postgres with a stand-in `auth` schema; `packages/db/test/harness.ts` provides it
  (local `initdb`, or `TEST_DATABASE_URL`).
- Alternatives considered: supabase-js/PostgREST everywhere (clunky for bulk upserts and CTEs);
  Neon + a standalone auth library (more parts to run).
