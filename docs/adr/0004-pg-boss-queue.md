# 0004 — Postgres-backed job queue (pg-boss v12)

Status: accepted (2026-09-04)

## Context

The worker runs fetch, extract, translate, asset, and claim jobs with retries, dedup, priorities, and
cron. Workers must run anywhere with a database connection (Fly.io, a VPS). Redis would add
infrastructure; Cloudflare Queues would tie workers to Cloudflare; Supabase's `pgmq` lacks retries,
backoff, cron, and dead-letter queues and had an open install bug on PG 17.6.1.016+.

## Decision

- pg-boss v12 on the application database, in its own `pgboss` schema.
- Named queues per job family (`feed.fetch`, `translate.body`, …) with singleton keys for dedup,
  priorities for on-demand vs background work, retries with backoff, expiry, and dead-letter queues.
- One worker process; `WORKER_ROLES` filters which `boss.work()` subscriptions start.
- The web app enqueues through a small SQL helper in `packages/db` (pg-boss documents the insert
  contract for non-Node runtimes), in the same transaction as the status write. Fallback: workers
  poll `requested` rows with `FOR UPDATE SKIP LOCKED`.

## Consequences

- No extra infrastructure; queue state is visible with plain SQL and backed up with the data.
- Throughput is bounded by Postgres polling; fine for feed reading scale, revisit if job volume
  reaches thousands per second.
