# 0063 — Limits on what a member adds, and when the operator is told

Status: accepted (2026-10-25). Builds on 0056 (runtime settings): every limit here is one of its
settings, read in the statement that enforces it. The translation half of the launch's limits
(the day's new translations, waiting bodies, the site budget's gate) is 0057's.

## Context

Open sign-up lets anyone add feeds, and what a feed costs is not what it looks like. A feed new to
Tela is fetched for as long as Tela runs, and its archive's titles are translated at once into
three paid languages: about 23k tokens on average, 163k at most (measured 2026-10-25). The owner,
the only member who adds feeds today, added 26 in his busiest day and usually 1 to 14. A
subscription costs the device: its first sync grows by about 12 KB a blog, so 65 subscriptions are
about 800 KB and 300 would be about 3.6 MB.

Subscribing to a feed Tela already has costs neither, and most of what a member does is that:
Discover, a blogroll's Subscribe to all, the known part of an OPML file. A limit that held those
back would refuse what is free.

Three constraints shape the rest:

- D1 is batch-only, so a limit is enforced in the statement that spends it, never by a read and a
  later write (AGENTS.md, invariant 3).
- A refused mutation is dropped without a word (ADR 0025): a device that predicted a subscribe the
  server refused shows it until the next pull, and then it is gone.
- The operator is asleep for a third of any day, and the Monday digest is days late for a budget
  spent at 2 a.m.

## Decision

**Three settings bound an ordinary account; an admin is exempt from all three.** The exemption is
one SQL term (`profiles.is_admin = 1`) OR'd into each room, never into the site budget or the
hourly limits of `action_limits`, which guard against a runaway client whoever runs it. Each room
is SQL (`feedRoom`, `subscriptionRoom` in `packages/data/src/queries/allowances.ts`) that reads its
setting inline: `NO_LIMIT` (a billion) when none applies, so it stands in `min()` and in a `LIMIT`
as it is. Null is no limit and 0 is none, as 0056 has it.

**`member.feedsPerDay` (20): feeds new to Tela, per UTC day.** Counted as the feeds the member
added since UTC midnight (`feeds.added_by`, `created_at`; the index came with migration 0014).

- Only a feed Tela has never had counts. A URL Tela has, a redirect to one, and a merged feed's
  address are free: the check sits in the statements that write the feed (`ensureFeed`'s
  `within`), after discovery, so whatever the address became is what is judged.
- Adding by URL counts, and so does a claim that brings a feed new to Tela; a claim of a blog Tela
  has does not.
- tela-api asks tela-jobs' `Ingest` RPC to count (`withinDay`). A tela-api from before this asks for
  nothing and nothing is counted, so the deploy order (tela-jobs first) needs no care.
- Past the day: `429 {error: 'feed_limit', limit, resetsAt}`, worded with the time the day comes
  back in the reader's own clock ("after 08:00" in Beijing).
- Two adds at the day's last place cannot both take it: the room is evaluated in the statement
  that inserts, and the site's statement in the same batch reads the same room.

**An OPML import adds what the day allows and keeps the rest for later days.** One batch, as
before, in the file's order:

1. every feed Tela has is subscribed, free;
2. as many new ones as both the day and the cap leave room for are added under a placeholder site,
   as an import always added them, and subscribed;
3. the rest wait in `pending_feeds`, as many as the cap leaves room for beside those already
   waiting;
4. past the cap a feed is left out.

The answer says how many of each, and the page says when the rest arrive: "Tela adds 20 new blogs a
day for you; the other 48 arrive over the next 3 days."

**`member.pendingFeeds` adds them on the days after.** A kind keyed by member, with no host since
nothing is fetched. Its due query finds a member with waiting feeds while a run would move
something: the day and the cap both have room, or a waiting feed is one Tela has now (someone else
added it meanwhile: a free subscription, at once). A member at the cap keeps their wait and is not
swept until they have room, and so does a suspended member (0059) until the suspension is lifted.
The run reads the member's waiting rows, 500 at most: those the member follows already, then the
ones Tela has now, then the oldest, since whatever made the run due must not wait behind more rows
than a run reads (a cap raised past 500 allows that), and writes them in one fenced batch by the import's own statements, so a holder that lost its lease adds nothing and a run again adds nothing twice. The
batch also refuses itself, as the fence does, for a member out of standing: suspended or closed
(0058) after the run was claimed, they have nothing added. Exhaustion pushes the member's wait a day out (`queued_at`, which the due query
reads); a retry from the console brings it back. The feeds it adds are due at once, and the feed
sweep fetches them as it fetches an import's.

**`member.maxSubscriptions` (300): subscriptions one account holds.**

- The `subscribe` mutation's insert carries the room as a predicate, as `putFolder` carries
  `MAX_FOLDERS`. Past it a subscribe writes nothing; one already followed was a no-op anyway.
- `POST /api/v1/feeds` refuses before it fetches (`409 {error: 'subscription_limit', limit}`), so a
  member at the cap adds no feed nobody would read, and its subscribe holds the cap as well. A URL
  naming a feed they follow already (as tela-jobs registers it, `asUrl`, or a feed merged into
  one) takes no place and is answered as ever; a page or a redirect that leads to one is refused,
  since knowing would take the fetch the check saves.
- The import and the pending kind stop at it, as above.

**The device refuses first, and says why.** A refused subscribe is dropped without a word, so the
reader checks before it predicts (`pastSubscriptionCap` in `@tela/sync`): Subscribe everywhere goes
through `useMemberControls`, and Subscribe to all checks the whole plan and says how many still fit.
The toast: "You follow 300 blogs, the most one account holds. Unsubscribe from one to add another."
The device learns the cap from the usage answer, asked once per tab by the first page that offers
Subscribe and kept in memory per account. Without it the device refuses nothing: the server holds
the cap either way. The prediction stays optimistic: two devices can each take the last place,
and the pull settles which one holds it.

**`GET /api/v1/account/usage` is a live answer.** `{translations: {perDay, usedToday, waiting,
resetsAt}, feeds: {perDay, addedToday, pending}, subscriptions: {max, count}, exempt}`, `no-store`,
in one read. Not synced: the counts change with every add, and a device's copy would be stale
exactly when it matters. An admin's limits read as null, with `exempt` saying why, so the reader's
checks never hold back anyone the server would not. Settings › Translation shows the day's new
translations ("3 of 20 today"), and Settings › Subscriptions the imported blogs still waiting and,
from four fifths of it, the cap. It is registered before the account routes' session read from D1,
which it does not need: it is no security state, and the member check every `/api/v1` route has
already names the member.

**The operator is mailed when something needs them before Monday.** `checkAlerts` in
`apps/jobs/src/ops.ts`, every fifth minute beside the health check, on the Singapore-pinned tick,
mailing `DIGEST_TO` as the digest does (`outboxFrom`, shared by both):

- **`budget:<p>`**: the day's tokens, everyone's together (`used + reserved` across `usage_daily`),
  reached p% of `translation.siteDailyTokens`, for each p in `alerts.budgetPercents` (80 and 100).
  Once a day each; shares reached together are one mail. A budget of null (none) or 0 (paused on
  purpose) has no share to warn about.
- **`signups`**: more accounts joined in the UTC day than `alerts.signupsPerDay` (50), counted by
  profiles as the sign-up cap counts them (`accountsTodaySql`). Once a day.
- **`reports:<hour>`**: reports are open and one came in since the last such mail. At most once an
  hour, and only for a new report, so an open queue the owner has seen does not nag.

Each alert first inserts its marker (`ops_alerts`, keyed by UTC day and name, `on conflict do
nothing returning name`) and mails only when the insert returned it, so overlapping runs never
send one twice. A send that throws deletes its marker, and the next run tries again. Without an
outbox nothing is checked or marked, so setting `DIGEST_TO` later loses nothing. The mails are
plain English text with counts and console links, never a member, an address or what a report
says.

**The console edits every setting.** A Settings area (Running › Settings) lists each one with what
holds now, its default and when it last changed, and edits it in its record through the audited
`setting.set`, whose toast offers the undo. A value is checked in the browser with `parseSetting`,
the rule tela-api and the CLI apply, and one the rule refuses is said in the console's own words
before anything is sent. Null and 0 are worded per setting, since they mean different things: no
limit, never alert, or tela-jobs' own budget var for the title budget; 0 always means none, so it
pauses joining or translation. tela-api answers the nine settings whole, so the area filters
(All, Changed) and searches on the client.

## Alternatives considered

- **Counting every subscription a member makes in a day.** Simple, and it would hold back
  Discover, blogrolls and the known part of an import, which cost nothing. The cost is in feeds
  new to Tela, so that is what is counted.
- **Refusing an import past the day.** The member would have to split their file by hand and come
  back each day. Keeping the rest, and saying when they arrive, is the same bound without the work.
- **Checking the day in tela-api before the RPC, by URL.** Simpler, and wrong for a redirect to a
  feed Tela has, which would be refused although it costs nothing; and racy, since the read and
  the write are two round trips apart.
- **The cap in the device's reducer.** The reducer cannot know a runtime setting, and a pull
  settles a refused prediction anyway; refusing before predicting is where the member hears it.
- **Putting the cap in the pull.** A protocol change for one number that moves rarely; the usage
  answer already exists for Settings.
- **An alert per run while over a threshold.** One budget spent at midnight would mail every five
  minutes until the next day.

## Consequences

- A member who imports a large file sees part of it now and the rest over the next days, worded
  in the summary and in Settings; an admin's import arrives whole.
- A feed that waits arrives in no folder: `pending_feeds` keeps no folder, so the import's folders
  file only what it added that day. A `folder` column would fix it.
- `pending_feeds.title` stays empty: the OPML reader returns URLs and folders, not titles, and
  nothing shows a waiting feed by name yet.
- A device shows a subscribe the server refused for as long as it takes to pull, when two devices
  take the last place at once, or when the device never heard the cap.
- An operator who lowers the cap below what members hold takes nothing away: past it they can
  only unsubscribe until they are under it.
- The rooms sit in `LIMIT` clauses as subqueries. The data contract suite runs them on libSQL and
  D1; the subscribe cap's refusal is in the convergence suite.
