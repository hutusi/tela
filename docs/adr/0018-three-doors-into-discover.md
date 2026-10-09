# 0018 — Three doors into Discover: editorial, claimed, community

Status: accepted (2026-09-18). Supersedes ADR 0011's listing rule; its claim mechanics stand.
Amended by 0041 (2026-10-07): an operator reviews the blogs members add and may list them, and a
public reader count is given only from three readers. Names corrected 2026-10-07 (below).

## Context

ADR 0011 gave Discover one automatic door: a site becomes `listed` the moment a claim is verified,
and `featured` was left as "a manual flag (SQL for now, an admin page later)". Nothing ever wrote
`featured`, so in practice there was one door, and it needed a blogger to prove control of a
domain before the directory held anything at all.

In production that is exactly what happened. Members subscribed to blogs, every one of those sites
was created `private`, and `/discover` said "No blogs listed here yet. Claim yours to be the
first." A first member does not read that as *no claims yet*; they read it as a broken page. A
claim gate cannot solve a cold start, because the gate is the cold start.

The obvious alternative — list whatever anyone subscribes to — trades one problem for a worse one.
With a two-member private beta, "sites somebody subscribed to" is one member's reading list,
published, and the member is identifiable by elimination.

## Decision

Discover lists a site that came through any of three doors.

- **Editorial.** A curated list in `apps/worker/src/seed/curated-sites.ts` is applied by
  `worker:once seed-discover`, which fetches each blog once and marks its site `featured` with
  editorial topics. The list is checked in, so changing it is a reviewable commit rather than a
  psql session. `curateSite` (`packages/db/src/queries/discover.ts`) is the write.
- **Claimed.** Unchanged from ADR 0011: a verified claim moves a `private` site to `listed`, and
  it is the only door that earns the ✓ on the card.
- **Community.** `recomputeReaderCount` promotes an unclaimed site to `listed` once
  `COMMUNITY_LISTING_MIN_READERS` (3) distinct members subscribe to it.

Three readers, not one. At one, the directory republishes a reading list; at three it is an
aggregate nobody can read backwards, and *who* subscribes is never shown — only the count the card
already displays. It costs nothing during the private beta because nothing reaches it, and the
door opens by itself when there are enough readers for the signal to mean something.

Community promotion reuses `listed` rather than adding an enum value. A fourth value would mean
editing the `listing in ('listed','featured')` predicate in five RLS policies plus an `ALTER TYPE
… ADD VALUE` that cannot be used in the transaction that adds it, and it would buy nothing:
`claimed_by is not null` already separates a claimed site from a community-listed one, and that is
what drives the badge, so the two stay distinct in SQL and on screen for free.

Promotion is one-way and skips `featured` and `rejected`. An unsubscribe should not yank a blog
out of the directory, and an editorial pick or an operator's veto is already decided.

## Consequences

- The directory stays curated, but by two kinds of judgement instead of one: a person proved they
  own the site, an editor chose it, or enough readers did.
- `rejected` is now the veto that matters, because two of the three doors open without anyone
  deciding per site. `curateSite` treats it as sticky: a seed re-run never resurrects a site
  somebody hid.
- Seeded sites have `added_by = null`, no subscriber, and `reader_count = 0` until a member
  subscribes, so the editorial row sorts first and the rest sort by readers.
- A claimant's topics beat the seed's. `curateSite` writes topics only while a site is unclaimed,
  so claiming a featured blog takes over its topics without losing the listing.
- **Featuring a site makes its rows readable by the Supabase `anon` role** through
  `sites_select_public` and the matching `feeds`/`articles` policies. Inert today because the Data
  API is off (ADR 0014) — but it means re-enabling the Data API publishes exactly the seeded set,
  which is now a deliberate list rather than an accident.
- The seed fetches from wherever the command runs, not through the relay, and passes no region
  policy: a mainland-China host that times out is reported as an error, and the fix is `region:
  'cn'` on its entry.

## Corrected (2026-10-07)

This ADR was written on the Postgres stack; the names it uses are now these (ADR 0020):

- `apps/worker/src/seed/curated-sites.ts` and `worker:once seed-discover` are
  `apps/api/scripts/curated-sites.ts` and `bun run admin curate`.
- `curateSite` (`packages/db/src/queries/discover.ts`) is `curate()` in
  `apps/api/src/routes/curate.ts`.
- `recomputeReaderCount` is `recountReaders` in `packages/data/src/queries/sites.ts`.
- The paragraph on RLS policies and `ALTER TYPE`, and the consequence on the Supabase `anon` role,
  are obsolete: D1 has no roles or policies, and `apps/api/src/routes/public.ts` filters every
  public answer by listing. Reusing `listed` for community promotion stands on its other reason,
  that `claimed_by is not null` already tells a claimed blog from one readers listed.
- "Only the count the card already displays" no longer holds below three readers: ADR 0041 gives
  a public count only from the community door's threshold up.

## Amended (2026-10-09)

The editorial list no longer features everything it lists. At 35 blogs, featuring every one was
harmless. At 110 it meant nothing: Discover sorts featured blogs first, so when nearly everything
was featured its first page was simply the oldest entries. Every entry is now listed, and only
the few marked `featured: true` in `apps/api/scripts/curated-sites.ts` are featured: a front
shelf, picked by hand for posting and for its spread across languages and topics. Applying the
list moves a blog that lost the mark back to listed. A blog removed from the list keeps whatever
listing it had. `POST /api/admin/curate` requires `featured`, since a script that predates it
would otherwise feature the whole list again. A rejected blog stays rejected whatever the list
says, and either listing records the operator's review as listed (ADR 0041).
