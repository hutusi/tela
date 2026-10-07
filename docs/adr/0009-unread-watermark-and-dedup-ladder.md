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
- A member can mark a post unread by hand (amended 2026-10-07). `user_article_states` gains
  `read_updated_at`, the clock of a read or unread chosen by hand. A row with no `read_at` and
  that clock set is marked unread, and it beats the watermark and the horizon until a later read.
  So unread = `marked unread OR (id > watermark_id AND fetched_at > now() - 30 days AND NOT
  EXISTS read row)`.
  - A first read stays clock-less, so compaction drops it under the watermark as before.
  - A read or unread over one chosen by hand goes to the later `at`, and a read made after an
    unread keeps its clock.
  - A read of a post already read keeps the first time but moves the clock to its own when it
    is later, and "mark all read" moves the clock of a post read by hand the same way (Codex
    review, 2026-10-07). A read that changed nothing left the older read's time to decide, so an
    unread made between two reads and pushed after both won over the newer one. The row then has
    a clock and outlives compaction, which takes two devices reading one post unaware of each
    other. Merging a feed (0028) carries a duplicate's read with that clock, as late as the later
    of its first time and its clock, and over a copy already read it moves the copy's clock the
    same way; carried by its first time alone, the later read was lost in the merge.
  - Compaction keeps every row with the clock: dropped, a post marked unread would read as the
    watermark says, and one read again would lose to an older unread pushed late.
  - A like never moves a choice made by hand, though liking still reads a post nobody chose for.
  - "Mark all read" also reads, with its own clock, the posts it covers that were marked unread
    before it, though not one marked since.
  - Merging a feed (0028) leaves a post marked unread unread, and carries a duplicate's unread
    to the target's copy as it carries a read.
  - A post marked unread is kept past the horizon while its feed is followed, as a liked post is
    kept whatever is followed (0025): a snapshot sends it, a delta sends it whole once it is
    marked (the device may never have held it, as with a search hit), and a resubscription
    brings it back with the feed's horizon. Without that, a device that took its snapshot after
    the post left the horizon never received it, and counted one unread fewer for good.

  The watermark has no device clock of its own. An unread made on one device before a "mark all
  read" on another, but pushed after it, therefore wins, and the post shows unread. This fails
  toward unread, and the member can mark it read again.

  Two more cases fail toward unread, documented rather than fixed (review, 2026-10-07). A device
  whose clock runs behind cannot read, by opening or by hand, a post marked unread elsewhere a
  moment earlier: the later `at` decides, and tela-api clamps only times in the future, so the
  read loses until that device's clock passes the unread's. And opening a post under its feed's
  watermark sends no `markRead`, since the device already shows it read; an unread made elsewhere
  before the open that arrives after it therefore leaves the post unread. Pushing a read on every
  open would close that, at a write per post opened.
- `articles.dedup_key` comes from a ladder: `g:<guid>` when the guid is non-empty, else
  `u:<normalized link>` (https, lowercase host, no fragment, tracking parameters removed,
  parameters sorted, trailing slash trimmed), else `h:<sha256(title|published_at)>`.
  `unique(feed_id, dedup_key)`.

## Consequences

- No per-item writes are needed for "mark all read"; the horizon bounds the scan.
- A feed that adds guids later can create one duplicate per existing item; accepted.
- Published dates remain what is shown and sorted by; they simply do not decide read state.
