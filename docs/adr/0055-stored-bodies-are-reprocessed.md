# 0055 — Stored bodies are made again from their raw HTML when the pipeline changes

Status: accepted (2026-10-25). Completes 0053: a pipeline fix now reaches every stored body, not
only what is fetched after it.

## Context

A fix to how a body becomes blocks (sanitizing, normalization, skip rules) changed only what was
processed after it. The two repairs of October 2026 (ADR 0053, 0054) reached stored posts the only
ways there were, and both fell short:

- **forcing feeds to process every item they still list.** A post its feed no longer listed kept
  its broken shape: 73 after the paragraph fix, more after the second.
- **making extracted posts due for extraction again.** That fetched every page again: two pages
  were gone, and twenty at a time was the most the health check allowed, by hand, behind a script.
  Queuing all of one site's posts at once had paged the owner.

Every version already keeps the raw HTML it was made from (`raw_key`, ADR 0022), kept so that "a
`NORM_VERSION` bump can replay the pipeline". Nothing replayed it: a `NORM_VERSION` bump would
have left every stored body refused by the body job.

## Decision

**Every version records the pipeline it was made under.** `article_versions.pipeline_version`,
stamped with `PIPELINE_VERSION` (`packages/shared`) by every insert. Existing rows start at 0.
`PIPELINE_VERSION` is bumped with any change to what `processArticleHtml` makes of a body, and
with every `NORM_VERSION` bump (AGENTS.md invariant 15).

**`article.reprocess` makes the current version again.** An article is due while its current
version was made under an older pipeline (`dueReprocessing`, read through an index on
`pipeline_version`, so it reads nothing once all are current). The job:

- reads the version's raw HTML from blob storage and runs today's `processArticleHtml` and
  `buildContentObject` over it. The base is the one the body was first made against, which every
  version now keeps as its `source_url`: the item's link, or for an item with no link of its own the
  feed's address *as it was then*, since a feed that moves later would otherwise move an old post's
  relative images (Codex's second review). Older rows fall back to the article's link, then the
  feed's address; production had no link-less article when this landed. The hint is the article's
  own language, so a near tie stays as it was;
- if the content object comes out with the same key *and* what the version derives from it beside
  the object (excerpt, word count, reading time, body length) comes out the same, stamps the version
  current and writes nothing else. The content key hashes the annotated body alone, so an
  excerpt-only fix would otherwise be stamped away;
- if either differs, stores the object (unless its key is the one already stored) and adds a
  version of the same provenance from the same raw HTML. A version that differs only in what it
  derives keeps the content key, and with it every body translation;
- a body's language is its content object's, which is immutable, keyed by the body alone, and what
  the body job reads its source language from. So an unchanged body keeps the language it has: a
  corrected one would have said English while its object said French, and refused a French reader
  as "already in that language" (Codex's second review). A language follows a new body, and a
  detector fix alone does not reach stored posts. `chooseCurrent` then makes it current, since it reads each provenance's latest. The article
  points at it (excerpt, counts, title hash, seq), and `extract_state` is left as it was, since
  nothing was fetched;
- with no raw HTML (a version from before it was kept, or an object gone), stamps the version and
  keeps it.

Each is one fenced batch under the article's lease (invariant 6). Only the current version is made
again; older ones are history.

**Writers do not overwrite each other.** A feed's fetch, an extraction and a reprocess each add
versions under a lease of their own kind, so two can read one article at once and both take the
next version number. The second insert was ignored, and its article update then pointed the
article at the first writer's row with the second's content key, for good (Codex's review
reproduced it; the race between a fetch and an extraction was there before this job). Now an
article moves only from the current version it was read at, and only onto a row that holds the
content it brings (`pointAt`, and the same two conditions in `updateArticles`). A writer that lost
writes nothing and learns it from the empty `RETURNING`: a reprocess is due again if its version
still is, and an extraction retries. A feed's fetch must not lose its change behind its own
validators: the batch that planned the change also saves the feed's ETag and body hash, and the
next fetch would answer 304 and never look at the item again. So the same batch ends with
`replayIfRejected`, which forgets them and makes the feed due now whenever a planned article did
not land on its planned version; the next fetch reads every item and decides again. The feed's
batch writes its versions before it moves its articles, so the row is there to find.

One loss a replay cannot mend: a reprocess that made, from the stored HTML, the very body the feed
brings, on the very version number the feed chose. The feed's move is refused, but the next fetch
finds that body stored and skips the item, and the title the blogger edited with it (Codex's third
review). So the feed's update is two statements: the body moves only from the version it was read
at, while what only the feed knows (title, link, author, date) lands whenever the article ends up
on the row the change chose, whoever moved it there. Nothing else writes those columns, and a
feed's fetches run one at a time under its lease.

**Pace, not politeness.** Nothing is fetched, so the due query names no host and a success claims
nothing after it. The tick's limit is the pace: 50 a minute, newest first, on the extract queue.
Neither health check's backlog counts it.

**A version's content is still never rewritten.** The stamp is the only column the job updates on
an existing version: "checked under pipeline N", not a new body.

## Consequences

- A pipeline fix is one constant bump and a tela-jobs deploy. The first deploy with the column runs
  every article once (all start at 0), which applies ADR 0053 and 0054 to the posts the repairs
  could not reach.
- A changed body is a new content key. Devices fetch it, title translations rerun where the excerpt
  changed, and a body translation is redone when a member next opens the post, from the block
  cache for every leaf that did not change.
- A `NORM_VERSION` bump becomes possible: the same job makes every body under the new hashes.
- What a better *extraction* would fix still needs the page: the stored raw HTML of an extracted
  version is Readability's output, not the page. OPERATIONS keeps the re-extraction recipe for that.
- Forgetting the bump leaves stored bodies as they were, silently. Invariant 15 says so; nothing
  checks it mechanically.

## Alternatives considered

- **A flag an operator sets on the articles to redo.** Every fix would need someone to know which
  posts it touches, which is what the two repairs spent hours finding out.
- **Reprocess on read, in tela-web.** It would put the parsers in the edge bundle, and run the
  pipeline per reader instead of once.
- **Make every version again, not only the current one.** It doubles the work for bodies nobody
  is shown.
