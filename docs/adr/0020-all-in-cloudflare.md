# 0020 — All-in Cloudflare: Workers, D1, R2, Queues and Cron behind a pinned data plane

Status: accepted (2026-09-27). Supersedes 0002 (Next.js on Cloudflare via OpenNext), 0003
(Supabase, Drizzle and Hyperdrive) and 0004 (pg-boss). Amends 0001: Node remains the runtime
only for the relay.

## Context

Three things matter for Tela, in this order:

1. The site has to keep running for years with little attention.
2. It has to cost little.
3. It has to be movable to another provider in a weekend.

The stack this replaces had six providers on the core path: Cloudflare for the web, Supabase
for Postgres and Auth, Fly for the worker, Hyperdrive in between, Resend and Bailian. It also
had three ways to fail silently:

- Workers Free's 10 ms CPU limit was already failing in production (Error 1102, ADR 0017).
- A Supabase Free project pauses after seven days of low activity, and only the Fly worker kept
  it active.
- Fly restarts a machine only when its process exits, and a crashed machine had already stayed
  stopped once.

Production also showed that volume is small:

- 37 MB in total, the largest table being pg-boss's own job table (11 MB).
- Article bodies were 7 MB across 1,687 articles.

The spikes on 2026-09-27 (branch `spike/workers-ingest`, `spikes/RESULTS.md`) measured what
Workers can carry:

- **Ingestion.**
  - Every production feed fetches from Cloudflare egress, including the mainland blogs.
  - Parsing, sanitizing and annotating a whole feed takes at most 513 ms of CPU.
  - Readability extraction takes at most 397 ms.
  - Every legacy CJK encoding decodes.
- **Translation.** Bailian answers from a Worker with the existing mainland key.
- **Auth.** better-auth runs on D1, with sign-in codes delivered to qq.com and 163.com.
- **Where the database lives.** The D1 primary created with `--location apac` is in Singapore:

| Where the code runs | D1 round trip |
|---|---|
| A fetch handler pinned with `placement.region = aws:ap-southeast-1` | 6–10 ms |
| The reader's edge (Vancouver) | about 185 ms |
| Cron handlers (Paris) | 160–250 ms |
| Queue consumers (Los Angeles) | 160–250 ms |

- **Placement limits.** Placement never applies to cron or queue handlers. But one that calls
  its own pinned fetch handler through a service binding runs that work in Singapore, at
  8–14 ms per round trip.

## Decision

- **One provider for runtime and data:** Workers Paid ($5 a month) with D1, R2, Queues and Cron
  Triggers.
  - Supabase (database and Auth), Fly, Hyperdrive, pg-boss, Next.js and OpenNext are removed.
  - Resend (email), Bailian (the LLM) and the relay box for mainland feeds (ADR 0008) stay.
- **Three Workers.**
  - `tela-web` is the only public one and runs at the reader's edge. It serves the static app,
    immutable content objects and images through the per-colo Cache API. It checks sessions
    from a signed cookie cache and forwards `/api/*` over a service binding.
  - `tela-api` and `tela-jobs` are pinned to `aws:ap-southeast-1`, beside the D1 primary, and
    have no public route.
- **Only fetch handlers of the pinned Workers touch D1.**
  - Cron and queue handlers are thin dispatchers that call `SELF.fetch()` on internal routes, so
    their work runs next to the database.
  - Everything that touches D1 goes through the platform interfaces of ADR 0021, never a binding
    directly.
- **No read replication.** Every query is made from 6–10 ms away, so replicas would add a
  consistency problem, Sessions bookmarks, without adding speed.
- **Work is state-driven, not message-driven.** A domain row says what needs doing, a cron sweep
  claims it with a lease, and a queue only speeds that up (ADR 0021 defines the lease). A lost
  message costs nothing.
- `workers.dev` stays off for the public Worker (blocked in mainland China). The custom domain is
  still the only public origin.

## Consequences

- **Cost.** Recurring cost is $5 a month plus LLM tokens, the relay box and the domain. The Paid
  plan includes 10M requests, 30M CPU-ms, 5 GB of D1 and 1M queue operations a month, far above
  what Tela uses.
- **Nothing to restart.** No machine and no connection pool are left to look after, and no free
  tier can pause the database. A Worker's compatibility date freezes the runtime it was deployed
  on.
- **The latency budget of ADRs 0016 and 0017 stops being a constraint on the server.** A query is
  an 8 ms round trip, not an ocean crossing. What the reader waits on is decided by the client
  (the local-first reader), and the server is no longer the bottleneck.
- **Lock-in is real, and bounded by ADR 0021.**
  - D1, Queues, Cron, placement and the bindings are Cloudflare's.
  - The data model is plain SQLite, the objects are plain files, and the work model needs only
    a timer.
  - The exit path is Node + libSQL + S3 + `setInterval`, and the test suite runs on it.
- **D1's limits become rules:** 10 GB per database, 100 bound parameters per statement,
  1,000 queries per invocation, and no interactive transactions. ADR 0021 turns each into an
  invariant.
- **D1 export refuses databases with FTS5 tables.** So search is `LIKE` over title columns, which
  costs about 2 ms at 5k titles, including two-character Chinese queries.
- **Alternatives considered:**
  - Keep Postgres (Supabase or Neon) with better-auth, Workers Paid and the Fly worker: the least
    rewrite, but three vendors on the core path and a free-tier cap and pause.
  - One box running Node, SQLite and Litestream: the fastest database and the easiest to move,
    but a machine to look after.
  - Turso instead of D1: another vendor, which pays off only if compute stays off Cloudflare.
