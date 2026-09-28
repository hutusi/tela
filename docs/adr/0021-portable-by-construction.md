# 0021 — Portable by construction: batch-only SQLite, one lease primitive, adapters behind interfaces

Status: accepted (2026-09-27). Constrains how every package written for ADR 0020 touches data,
blobs, jobs, mail and time.

## Context

ADR 0020 puts Tela on Cloudflare-only services. The owner's third requirement is still that Tela
can move providers in a weekend. That holds only if nothing in the code depends on something a
move would take away.

D1 has no interactive transactions, only atomic batches. The code this replaces had 14
interactive transactions and an advisory lock. It also had a translation attempt, heartbeat and
sweeper machinery of about 550 lines and 700 lines of tests, written to work around pg-boss's
semantics:

- Its `short` policy de-duplicates only `created` jobs.
- A lease can outlive the job that holds it.
- Enqueueing happens in the same transaction as the state it describes.

Much of `AGENTS.md`'s gotcha list is that machinery. That includes the fetch race whose
documented fix was "serialize per feed rather than adding a fourth guard".

## Decision

**Adapters behind interfaces** (`packages/platform`). Nothing outside it imports a Cloudflare
binding. The test suite runs on the portable column; production runs on the Cloudflare one.

| Interface | Cloudflare | Portable (tests and the exit path) |
|---|---|---|
| `Db` (Drizzle sqlite) | D1 | libSQL |
| `Blobs` | R2 | memory, S3 (any compatible store) |
| `Jobs` | Queues | in-process queue |
| `Clock` | wall time | fake |
| `Mail` | Resend over fetch | memory outbox |

**Batch-only SQL.**
- Code uses single statements and atomic batches only, never `transaction()`. D1 and libSQL
  share exactly this subset. The `Db` type has no `transaction` method, so the compiler refuses
  it, and the portable libSQL client throws if anything reaches the driver's own.
- The portable `Db` enforces D1's other limits on every statement, so a test fails where
  production would: at most 100 bound parameters, 100 KB of SQL, and five terms in a compound
  SELECT (measured 2026-09-28; SQLite's default is 500, and a multi-row `VALUES` is not a
  compound).
- Bulk reads and writes pass one JSON parameter through `json_each(?1)` instead of N×columns
  parameters.

**One lease primitive for all background work.**
- A domain row's own predicate says what is due, e.g. `feeds.next_fetch_at <= now`.
- **claim.** A claim is one upsert into `leases(kind, key, owner, until, attempts, not_before,
  host)`:
  - It takes only rows whose lease has expired and whose backoff has passed.
  - It skips hosts that already hold a live lease (politeness).
  - It returns what it took.
- **continue.** After a success, the runner claims the next due item of that kind on the same
  host and sends it two seconds later. A tick takes one item per host, so without this a summary
  feed's 30 new posts took half an hour to extract; with it a host's backlog drains at request
  speed, still one request at a time.
- **extend.** Extending is a conditional update on the owner.
- **Fenced batch.** Work decided in JavaScript commits as a *fenced batch*:
  - Its first statement is `INSERT INTO lease_fence(x) SELECT NULL WHERE NOT EXISTS (my live
    lease)`.
  - `lease_fence.x` is `NOT NULL`, so a lost lease aborts the whole batch, on D1 and libSQL
    alike.
  - The batch ends by releasing the lease.
- **start and fail.** Starting work renews the lease and raises `attempts`; a reported failure
  sets `not_before` with exponential backoff, and at the maximum the item becomes a dead letter.
  The count is taken at the start, not at the failure (2026-09-28, found in the Gate G2 shadow
  run): a holder that dies over its CPU or memory limit reports nothing, and its lease only
  expires. Counted at failure, that item would be claimed again every TTL for ever, at the price
  of a model call each time for a translation. Counted at the start, the claim that finds it
  already spent retires it as a dead letter instead of sending it. A message that waited in its
  queue past the lease never starts, so queue lag costs no attempt.
- **Holders.** Only a lease holder may write columns that jobs own. The API holds no leases, so
  it writes single conditional statements.

**A sync sequence.**
- Any batch that changes a row readers sync begins with `UPDATE counters SET v = v + 1 WHERE
  k = 'seq'` and stamps its rows with that value.
- SQLite has one writer, so seq order is commit order and there are no gaps. A reader's cursor
  is simply the last seq it has seen.

**SQLite conventions.**
- Timestamps are epoch milliseconds in `INTEGER`.
- Enums are `TEXT` with a `CHECK`.
- Arrays read whole are JSON `TEXT` with `CHECK(json_valid(...))`; arrays that get filtered
  become join tables.
- `articles.id` is `AUTOINCREMENT`. A plain rowid can reuse a deleted maximum, which would break
  the unread watermark of ADR 0009.

## Consequences

- **Leaving Cloudflare** means swapping the adapters and starting a timer that calls the same
  `tick()`. The tests run on that exact path, so it can't quietly rot.
- **Two fetches of one feed can no longer run at once**, since the feed's lease serializes them.
  This retires the `last_body_hash`/`last_fetched_at` compare-and-swap and its known residual.
  A lost queue message loses nothing: its lease expires and the next tick claims the row again.
  That closes the "nothing queued the title job" class of bug.
- **The translation attempt model is retired.** Its three jobs — superseding, heartbeats, and
  refusing a stale writer — are now the lease, extending it, and the fence.
- **Per-member translation allowances need no advisory lock.** A reservation is one batch of
  two conditional statements over a `usage_daily` row.
- **Every query shape has to fit D1's limits up front.** A 200-item first fetch is two batches,
  not 800 queries. This is written down so the next query written is shaped the same way.
- **One gotcha to remember:** SQLite's `INSERT … SELECT … ON CONFLICT` needs a `WHERE` on the
  SELECT, or the upsert clause is parsed as part of a join. `WHERE true` is enough.
