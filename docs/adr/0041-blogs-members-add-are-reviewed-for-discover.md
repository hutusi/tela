# 0041 — Blogs members add are reviewed for Discover

Status: accepted (2026-10-07). Amends 0018: an operator's review of the blogs members add is a
way into Discover beside its three doors, and a public reader count starts at the community
door's three. Amends 0039: the console's Discover area opens on that review, and the operator sees
how many members read each blog under review, never who.

## Context

ADR 0018 opened Discover by three doors: the editorial list, a verified claim, and three members
subscribing to an unclaimed blog. In a small private beta the third door does not open, and the
second opens only as often as a blogger happens to join, so the directory grew only when the
operator committed a change to the curated list. Meanwhile members add blogs every day, and every
one of them is created `private` and stays so.

The admin console (ADR 0039) had a Discover filter called Candidates: every private blog nobody
claimed. Nothing told the operator to look at it. It held placeholders no fetch had filled and
blogs whose feeds had died, and a blog the operator looked at and declined stayed in it for ever,
because declining had nowhere to be written.

The owner decided (2026-10-07) that every blog a member adds becomes a Discover candidate by
itself, with no button for members to press, and that the operator approves it. A "suggest for
Discover" button was considered and not built: it asks a member to turn what they read into a
public proposal, few would press it, and the suggestion itself says who reads the blog.

ADR 0018 rejected "list whatever anyone subscribes to" because in a beta of a few members that
publishes one member's reading list. An operator listing from the same reading reopens two ways
of reading it backwards: the public count, where "1 reader" on a blog nobody else reads names its
reader, and the console, where the operator sees which blogs members read.

## Decision

**A review queue of the blogs members add.** A blog waits for review when it is private,
unclaimed, read by at least one member, has a live, unmerged feed that has brought posts, and no
operator has decided about it (`sites.review` is null). The predicate is `DISCOVER_REVIEW` in
`@tela/data`, which the console's Discover ledger (the filter keyed `candidates`, shown as "To
review", and the area's first), its sidebar badge, the Overview's card and the Monday digest all
count. Unfetched placeholders, dead or merged feeds and blogs nobody reads any more wait for
nothing.

**Deciding takes a blog out of the queue, and the review records what was decided.** List,
Feature and Hide are decisions, and so is a new action, Not for Discover (`site.dismiss`). Each
writes `sites.review` and `sites.reviewed_at`: List and Feature record `listed`, Not for Discover
`dismissed`, and Hide, which is the veto rather than a review, keeps a review already made and
records `dismissed` only over nothing decided. `reviewed_at` is when the last decision was made,
so it dates the decision the review holds, or the veto over it, never one since overturned. Each
decision records the review and stamp it found, so undoing a mistaken List puts the blog back in
the queue. Not for Discover changes nothing else; both columns are the console's alone, so no
device's row changes and no seq moves, and the action is undone like any other.

Restore leaves the review. It returns a blog to what the doors say, and a review that listed the
blog is one of them: a blog listed or featured from the queue stays listed when it is
unfeatured, and one hidden from the queue comes back private and not for Discover, not asked
about again. A removed claim closes only the listing the claim opened, so a blog the operator
listed before its blogger claimed it stays listed when the claim goes. Curation records `listed`,
as Feature does.

**The doors stay open.** Not for Discover is not a veto. A dismissed blog is listed by the
community door once three members read it, since `recountReaders` never reads the review; Hide
(`rejected`) remains the veto that sticks. An operator's List is editorial, like a curated pick,
except that it starts from what members read rather than from a list in the repository.

**A public reader count starts at three.** Every public answer gives a blog's count through
`publicReaderCount`: the count from three up, null below. That covers Discover, a blog's page and
member search, and Discover's order too, which ranks a held-back count as none, so 1 and 2 sort
with 0. The card and the page show nothing rather than "no readers yet", so a blog one member
reads looks like an editorial pick nobody has subscribed to. The Privacy page says this, and says
that the person who runs Tela reviews the blogs members add, seeing each blog and how many read
it, never who.

**What the review shows.** A row in the queue shows the blog's title, address and language, its
posts of the last 30 days, its latest post, its reader count and when it was added; its record
adds the blog's description and its topics. It never shows who added the blog (`feeds.added_by`)
or who reads it, in the row, the record or the history.

**Topics stay one click each.** There is no List-with-topics action. A blog listed with no topics
is filed only under All, so the toast after List or Feature says it has none yet, a listed row
says so in its line, and the record says so above the chips that set them.

## Consequences

- **The review queue is aggregate reading the operator sees.** For every blog any member adds,
  the console now shows that someone reads it and how many do. ADR 0039 kept each member's reading
  out of the console; this keeps out who, and not that. In a beta of a handful of members a blog
  with one reader may still let the operator guess whose it is. That is no more than the operator
  could already read from the database they maintain (the Privacy page says they can see it), but
  it is now put in front of them on purpose, and the Privacy page says so.
- Discover grows at the operator's pace without waiting for claims or three readers, and nothing
  is listed without a person deciding or three readers subscribing.
- A dismissed blog does not come back to the queue by itself, whoever subscribes next; three
  readers list it, and an operator who changes their mind lists it from Not for Discover.
- `site.dismiss` counts as writing the listing for the undo's purposes (`ACTION_WRITES`): a List
  or Hide after it stands in the way of undoing it, which would otherwise clear the stamp of a
  blog decided since.
- Migration 0007 records the review that a listing chosen before it would have recorded: featured
  blogs and unclaimed listed ones are `listed`, hidden ones `dismissed`, each stamped with the
  console's last listing action on it, or else when the blog was added. A claimed listed blog
  gets no review, since its listing is the claim's.
- A shell cached before tela-api returned null counts renders one as "no readers yet" for a
  visit, and a cached public page can show an old count for a day (ADR 0024's edge cache).
- A blog's subscribers still sync its `reader_count` with its row, but the reader pane shows it
  only from three readers too: below that, "2 readers on Tela" would tell a subscriber that one
  other member reads the blog. The row still carries the number; only the page holds it back.
- Migration 0007 added `sites.review`, its check added with the column rather than by rebuilding
  `sites` (a rebuild drops the table, which on D1, where foreign keys stay enforced, would run the
  cascades of every table that references it), and `sites.reviewed_at`. The digest gained a
  Discover line, and the console's catalogues the words for To review and Not for Discover.
