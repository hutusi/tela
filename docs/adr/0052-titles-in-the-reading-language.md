# 0052 — Titles in the reading language: the device names it, and fetches a new one by id

Status: accepted (2026-10-20). Amends 0025: a member's device holds titles in its reading
language only, not in every launch language. The protocol stays at 3.

## Context

A profile of the owner's account after the 2026-10-19 deploy found the cursor-0 snapshot at
2.18 MB compressed, taking 8 s to arrive. Titles were 3.4 MB of the 5 MB of synced rows. Every
post has a title row in each launch language (`en`, `fr`, `zh-Hans`, `zh-Hant`, ADR 0006 and
0038), and the device held all four while showing one.

Only two readers on the device touch its titles, and both go through the reading language:
`shownTitle` for every list and the reader, and `searchLocal` for search. Public pages and
Discover read their own answers, which carry the languages they need.

The server cannot pick the language for the device. The effective reading language is the
profile's `readingLang`, else the interface language (the profile's, else the cookie or the
browser's), else English (ADR 0040). Only the device knows all of that in every case: a member
who never chose a language reads in whatever their browser asks for.

Title rows are never deleted and have no tombstones. A device also keeps posts past the 30-day
horizon, since it prunes by subscription, not by age.

## Decision

**The pull names the language.** `GET /api/v1/sync?cursor=N&titles=<lang>`:

- tela-api adds `t.lang = ?` to the fresh title query and the changed one. That is one more bound
  parameter each, and no new compound.
- The answer says the language back as `titlesLang`.
- A value outside `READING_LANGUAGES`, compared exactly, is a 400 `invalid_titles`.
- The re-read for a cursor from the future, and the unpaged re-read of a batch larger than a page,
  keep the language.
- Pages end by the title rows of that language. Rows in other languages neither fill a page nor
  cut one.

**No `titles` means every language**, and the answer names none. That is what a protocol-3
shell sends and expects, so `MIN_CLIENT` stays at 3, no tab is made to reload, and tela-api and
tela-web deploy in the usual order. A tela-api from before this decision ignores `titles` and sends
every language: the device reads a pull without `titlesLang` as every language, keeps its own
language's rows and counts them as brought (`titlesIn`). A pull that names another language (one
asked for before the member switched, landing after) brings none of its own: the device drops
that pull's title rows and fetches its language again.

**A new language comes by id, not by starting over.** `POST /api/v1/sync/titles`, body
`{lang, ids}`, answers `{rows}`, in the pull's title row shape:

- At most 1,000 ids, each a positive integer, else a 400 `invalid_ids`. A bad language is a 400
  `invalid_titles`. No ids answers no rows.
- It reads by the ids the device holds, not by the server's horizon, because the device keeps
  posts past the horizon.
- It is scoped as the delta's titles are: rows of feeds the member follows, or of posts they keep
  (liked, recommended, highlighted). Asking for another member's post returns nothing.
- It is one statement: the ids pass as one JSON parameter through `json_each`, and each is a
  primary-key lookup on `(article_id, lang)`. Six bound parameters, and one three-term union (the
  kept posts), within D1's limits (AGENTS.md, invariant 4).
- The same checks as the pull guard it: a session, `x-tela-client`, `x-tela-member`, and the
  app-wide 64 KB body limit (1,000 seven-digit ids are about 8 KB).

**The device's titles are only ever in its language.** When the reading language changes, the
device drops the old language's rows at once. It records the new language as not yet whole, and
lists and the reader show original titles until the rows arrive. It then fetches them for the
posts it holds that lack one, 1,000 ids a request in id order, one request per round of its single
pull loop, so a page never lands before an old-language pull still in flight. A pass walks the ids
once: a post tela-api has no title for (not yet translated, or in its own language) is asked for
once a pass, not for ever, and the pass ending is what makes the language whole. The language, and whether the device holds it whole, are stored
beside the cursor and stamped with it, like the record of tables held whole: tabs share one copy,
and a tab still on the old language can move the cursor past rows of the new one.

A copy stored before this decision holds every language whole. It keeps the effective
language's rows and drops the rest, with no fetch.

Another tab or device learns of a switch through its own pull of the profile row, and fetches for
itself.

## Consequences

- A snapshot carries one language's titles instead of four. Each delta carries one title row per
  post where a title job writes up to four. The saving is measured after the deploy, by comparing
  `?cursor=0` with `?cursor=0&titles=<lang>` for the same member.
- Switching the reading language costs one request per 1,000 held posts, not a snapshot. Original
  titles show until it lands.
- tela-api still translates titles eagerly into every launch language (ADR 0006). Only what a
  device holds changes, so a switch finds the titles already written.
- Search on the device matches the reading language's titles and the originals, as before.
- A shell from before this decision keeps pulling every language until it reloads.
- After a rollback of tela-api, the backfill route is a 404. The device keeps showing originals
  for what it lacks and tries again on a later pull; the rolled-back pulls send every language, of
  which the device keeps its own.
- Body translations (`translations`) have the same four-language shape, and are left alone until
  they are measured.
