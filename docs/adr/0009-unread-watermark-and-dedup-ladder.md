# 0009 — Unread watermark on ingest order; article dedup ladder

Status: accepted (2026-09-04)

## Context

Unread state must be cheap for 10k users × 200 feeds, and "mark all read" must be one write.
Publish dates are unreliable: feeds backdate, republish, and omit them. GUIDs are also
unreliable: many feeds omit them, reuse the link with tracking parameters, or regenerate them on
every static-site rebuild.

## Decision

- `articles.id` (bigint identity) is the ingest order. `subscriptions.watermark_id` marks
  everything at or below it as read; unread = `id > watermark_id AND fetched_at > now() - 30 days
  AND NOT EXISTS read row`. "Mark all read" sets the watermark and lets a maintenance job
  compact read-only rows below it. A row that ever held a like is not read-only: it keeps when
  the like last changed, which a like pushed late from another device is compared against, so it
  stays (amended 2026-09-29).
- `articles.dedup_key` comes from a ladder: `g:<guid>` when the guid is non-empty, else
  `u:<normalized link>` (https, lowercase host, no fragment, tracking parameters removed,
  parameters sorted, trailing slash trimmed), else `h:<sha256(title|published_at)>`.
  `unique(feed_id, dedup_key)`.

## Consequences

- No per-item writes are needed for "mark all read"; the horizon bounds the scan.
- A feed that adds guids later can create one duplicate per existing item; accepted.
- Published dates remain what is shown and sorted by; they simply do not decide read state.
