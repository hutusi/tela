# 0057 — Translations past a day's limits wait for the next day

Status: accepted (2026-10-25). Amends 0006 and 0023: a count of new translations replaces each
member's daily token allowance (`USER_DAILY_TRANSLATION_TOKENS`), and a site-wide budget joins the
background one. The limits are runtime settings (ADR 0056).

## Context

Opening sign-up to anyone puts a price on every new account. Before this:

- **Each member had 400k tokens a day** for bodies, about ten posts at the 40k-per-post ceiling.
  Past it, a request was refused: "You have used today's translation allowance." The reader had to
  remember the post and come back the next day.
- **Nothing bounded the site.** `dueBodies` read no budget, so a thousand new members could spend
  400M tokens in a day. Only titles had a cap, `LLM_DAILY_BUDGET_TOKENS` (2M), a tela-jobs var that
  takes a deploy to change.
- **A token count means nothing to a reader.** Posts vary tenfold: a median post uses about 8–10k
  tokens and the largest 36k. "400k tokens" says neither how many posts that is nor when it ends.

Production as measured on 2026-10-25: only the owner translates bodies, usually 1–7 a day and at
most about 21 (2026-10-24), at most 266k tokens a day. Titles use 30–90k tokens on a usual day and
797k on a curation day. The heaviest day for the whole site was about 0.85M tokens.

## Decision

**A count, not tokens.** `member.translationsPerDay` (20) counts the body translations a member's
requests pay for per UTC day, in `usage_daily.requests`. Free, so not counted:

- a translation already made for anyone (`ready`);
- a conversion between the Chinese scripts, which reserves nothing (ADR 0038);
- a request that spent no tokens: every block was already cached, or it ended before a call.
  `settleBodyUsage` gives that count back when the request settles, never below 0.

The 40k-per-post ceiling still bounds each request, so a member's worst day is 20 × 40k, and the
site budget bounds the money.

**A site budget.** `translation.siteDailyTokens` (10M) holds every subject's tokens for the UTC day
together, members' and titles' (`sum(used + reserved)` over `usage_daily`, through
`usage_daily_day_idx`). Bodies are held to it when they are asked for, and titles as they are
found:

- `dueTitles` finds nothing once the site's day is spent, or the background budget is:
  `translation.backgroundDailyTokens`, or with none stored the env value it always was, where 0
  means no limit.
- A setting of 0 pauses what it budgets, and null means no limit (ADR 0056).
- Both are read inside the statement that enforces them (`settingSql`), so a change holds at the
  next request or tick.

**Past a limit, a request waits.** tela-api's admission is one conditional insert, and decides the
day itself:

- today, if the member's count and the site's day both have room;
- else tomorrow, if they have room then. The row is `requested`, with `reserved_day` tomorrow and
  `due_at` the next UTC midnight (08:00 in Beijing), and is reserved and counted on tomorrow;
- else nothing. The answer is `budget_exhausted`, with `reason` (`member` or `site`) and
  `resetsAt`.

The queue is one day deep at most. Every value is bound once, in a `with a(...)` header the room
terms name, so the statement takes about a dozen parameters (invariant 4). Its reservation is a
second statement that does nothing unless the row holds this request's id.

The answers are `requested`, `scheduled` (the row, with its `dueAt`), `in_progress`, `ready`, or
`budget_exhausted`. After an admission they also carry `allowance {perDay, usedToday, resetsAt}`.
The synced translation row carries `dueAt`.

**A waiting request is not due until its day.** `dueBodies(now)` skips a row whose `due_at` is
ahead, and so do the tick and tela-api's claim-now. The first chunk clears `due_at`, and so does
every ending. The health check counts a row stuck only half an hour after it fell due
(`max(updated_at, due_at)`), not half an hour after it was asked for. A post edited while its
request waited points at new content: the job ends the old request as failed (`superseded`) before
any call, and its reservation and count go back.

**Bodies are held at the door only.** A body admitted runs to its end, and continues across
executions as before (ADR 0023). `dueBodies` reads no budget. Stopping a body mid-post would leave
the reader half a translation, and the overshoot is bounded by what was admitted, each at most its
reservation, which is also the job's ceiling on source tokens.

**A member with room today takes a waiting request over.** Opening a post that waits asks once
more. If the asker has room today, one batch, guarded by the old request id:

1. moves the row to the asker, due now, on today;
2. gives the old reservation and its count back to the day they were made on;
3. reserves and counts on the asker's today.

The last two do nothing unless the first moved the row, so of two members racing for it one has it,
and the other is told it is in progress. `requested_by` never goes null while a request is open:
the settle charges whoever holds it. An asker with no room today is told it waits, and so is one
past the hourly `translate` bucket: a waiting post is never answered 429.

**Operators are not put off.** is_admin skips the member count, and the site's day never defers an
operator's request, but their tokens count toward it: the owner's own reading stays visible in the
total and the alert. This follows the owner's decision ("count toward the budget but are not
paused") over the plan's line that is_admin covers the member limits only.

**The reader says when.** A row `requested` with a `dueAt` ahead is `waiting`. Nothing polls it;
the bar says "Tela will translate this after 08:00." in the member's own time, "tomorrow" when that
is not today where they are; a timer starts polling when it falls due. A refusal is worded by its
reason, calmly: "You've had 20 new posts translated today. Open this one again tomorrow." for the
member's count, "Translation is resting for today. Open this post again tomorrow." for the site's.

**`MIN_CLIENT` is 4.** A protocol-3 shell sees `requested` and polls it every 1.5 s until midnight,
and words a site pause as the member's own allowance. tela-web deploys before tela-api.

**The tick reports the budgets as they hold.** The heartbeat's `config.backgroundBudget` is the
setting, or the env value it falls back to, with null for no limit and 0 for paused, beside the new
`siteBudget`. A heartbeat without `siteBudget` is from a tick before this, whose 0 meant no limit:
the console reads it as no config yet rather than as a pause, and the dead-letter retry as no
limit.

**Titles come newest first.** Due feeds are ordered by their newest due post, and a job takes a
feed's newest 20 (`dueTitlesOfFeed`, and `failDueTitles` the same 20). An imported archive no
longer holds up everyone's new titles while the day's budget lasts.

## Consequences

- At 00:00 UTC every request that waited falls due together. The tick claims 20 bodies a minute,
  so a night with many waiting starts them over a few minutes. Watch the stuck check the first
  nights.
- Reservations lean high (1.5 times the estimate, plus 500), so the site's tomorrow can look full
  before it is. With 20 a member, it rarely matters, and each settle gives the difference back.
- A request reserved for tomorrow counts in tomorrow's site total from the moment it is asked for.
  Raising the budget, or a take-over, gives it room today.
- The site budget is crossed by what is in flight when the line is reached, never by new work:
  each admitted body is bounded by its reservation, and a running title job by its 20 titles.
- The console's Translation area shows the member limit as a count, how many members reached it
  this week, the site's day against its budget, the background budget as it holds, and how many
  bodies wait.
- `USER_DAILY_TRANSLATION_TOKENS` is gone. The reader still has a reason-less `budgetExhausted`
  line, for the minutes a new shell talks to an older tela-api.

## Alternatives considered

- **Refuse past the limit, as before.** A dead end: the member has to remember the post and come
  back to it.
- **Queue more than a day deep.** A backlog with no end is a promise Tela cannot keep, and an
  operator could not tell from the console what it had promised. One day keeps it small, and the
  notice can say when.
- **Keep a token allowance per member.** It means nothing to a reader and varies tenfold between
  posts. A count says how many posts, and the per-post ceiling bounds the tokens.
- **Hold running bodies to the site budget too, in `dueBodies`.** It would stop a translation the
  reader is watching halfway, for an overshoot that is already bounded.
- **Leave operators out of the site total.** Their spend would be invisible to the budget alert,
  and the owner is today's only heavy translator.
