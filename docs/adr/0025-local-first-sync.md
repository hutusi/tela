# 0025 — Local-first sync: one seq cursor to pull, idempotent mutations to push

Status: accepted (2026-09-28) for the server side, which tela-api implements. Phase 6 adds the
client (store, reducer, prefetch) to this record. It will supersede 0010, 0016 and 0017 when the
reader moves onto it, keeping 0017's rule that the URL alone says which article is open.

## Context

The owner's second goal is instant reading, from mainland China too. A mainland reader is served
from an overseas PoP without an ICP filing, so the round trip can be hidden but not removed: the
reader must not need it per click. Spike S5 measured the alternative: with a local store, the
list shows 35 ms after navigation and an article opens in 11–18 ms, while the first sync, about
700 ms from Vancouver, runs behind a list that has already rendered.

That needs a protocol a device can follow for years without the server remembering devices.

## Decision

**A cursor, not a device registry.** Every batch that writes a synced row bumps one counter and
stamps its rows with the new value (invariant 17). SQLite has one writer, so seq order is commit
order with no gaps, and a device's cursor is simply the last seq it has seen.

**Pull: `GET /api/v1/sync?cursor=`**, read in one batch: one snapshot of the database, whatever
commits meanwhile.

- What a member holds:
  - their own rows: profile, prefs, subscriptions, read and like states, recommendations,
    claims;
  - the shared rows of the feeds they subscribe to: feeds, sites, articles, titles in both
    launch languages, and body translations of those articles;
  - articles they liked or recommended, with those articles' feeds and sites, whatever they
    subscribe to now.
- Cursor 0 is a **snapshot**: the 30-day horizon (ADR 0009), with `reset` set.
- Any other cursor is a **delta**: rows with a seq above it.
  - A subscription newer than the cursor brings its feed's horizon whole, because those articles
    were written before the subscription and their seqs are below the cursor.
  - Unsubscribing is a subscription row with `deletedAt`; the feed stops flowing.
  - Hard deletes would travel as tombstones. None of Tela's writers hard-delete a synced row
    today: compaction drops only read states under a watermark, which the watermark already
    implies.
- **Pages** hold up to 1,000 rows per table and end on a seq boundary, never inside the rows one
  batch wrote. `more` says pull again at once. A batch larger than a page goes out whole rather
  than stalling; no writer produces one (the largest is a feed's 200-item cap).
- A **cursor ahead of the database** (restored from a backup) gets a snapshot.
- A **client older than `MIN_CLIENT`** (header `x-tela-client`) gets `409 upgrade`, so a cached
  app shell that has fallen behind reloads rather than misreading rows.
- Pulls read the D1 primary from the pinned Worker (6–10 ms). There is no read replication, so no
  Sessions bookmark and no read-your-writes gap to handle.

**Push: `POST /api/v1/mutations`**, up to 50 in one batch, which lands whole or not at all.

- The mutations: `markRead`, `setLiked`, `markAllRead`, `subscribe`, `unsubscribe`, `setPref`,
  `setProfile`, `recommend`, `unrecommend`. Their zod schemas in `@tela/sync` are shared with the
  client.
- **A replay changes nothing.** Each carries a client-minted `mid`, every statement is guarded by
  that id not being in `applied_mutations`, and the id is recorded last. Kept 30 days.
- **Conflicts go to the later `at`**: likes, recommendations and prefs are absolute values with
  last-writer-wins. `at` is clamped to the server's clock, so a device with a clock in the future
  cannot win every argument.
- **`markAllRead` takes `upTo`, the highest id the client displayed.** The Postgres app used its
  own `max(id)` and marked read posts the reader never saw. The watermark never moves backwards
  and never past what exists.
- **A bad reference is a no-op.** Rows are written through `insert … select … where exists`, so a
  missing article writes nothing instead of a foreign-key error sinking the batch. Invalid
  mutations are refused one by one; the rest apply.
- Adding a feed by URL and requesting a translation are RPCs, not mutations: the reader needs the
  answer.

## Consequences

- **A device needs nothing from the server but its cursor**, and the server keeps nothing per
  device.
- **Every write path owns its seq stamp.** A writer that forgets `bumpSeq` makes its rows
  invisible to devices whose cursors have passed. The dead-letter path did exactly this; it is
  fixed and tested.
- **The pull is one batch of about twenty reads**, all by indexed `(…, seq)` or by primary key.
- **The tests that guard it**, each shown to fail when its rule is removed:
  - the replay guard, where `setProfile` is the one mutation last-writer-wins cannot protect;
  - last-writer-wins on likes;
  - the clock clamp;
  - the missing-reference no-op;
  - the page boundary. It runs on libSQL and on D1.
