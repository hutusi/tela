# 0048 — Folders: a table of their own, one per blog, open on each device

Status: accepted (2026-10-16). Amends 0025: two synced tables and three mutations join the
protocol, which stays at 3.

## Context

Claude Design's Tela Lists draws three ways to group things: folders of a member's own
subscriptions, collections of posts, and blogrolls of blogs to share. This round builds folders
only. In the design:

- the sidebar and the phone's Feeds menu list folders that open and close, with their blogs
  under them;
- a folder's name opens one list of all its blogs, with the Unread/All switch and Mark all read;
- Settings › Subscriptions groups the blogs by folder. There you make, rename and delete folders
  and move blogs between them, by a menu on each row, by dragging on a desktop, and by a bottom
  sheet on a phone.

Its copy sets three rules. A blog sits in one folder at most, folders are private, and they
travel with OPML.

The design leaves four questions to the build:

1. **Where a folder lives.** The obvious place is a column on the subscription. But a pull sends
   a feed's whole 30-day horizon again whenever a live subscription's `seq` moves: its posts,
   titles and translations. Mark all read already pays that, once per feed per mark. A move
   between folders should not.
2. **How Mark all read covers a folder.** `markAllRead` takes one feed or every feed.
3. **Who knows whether a folder is open.** The design toggles it on the folder.
4. **How a delete, a rename and a move from two devices resolve.**

## Decision

**Two tables of their own.** `folders` holds the folders: a client-minted id, as a highlight's
is, the name, and the usual clocks. `feed_folders (user_id, feed_id)` holds which folder a blog
is in, with `folder_id` null for none. Its primary key is the rule that a blog has one folder. A
move writes one small row, and no subscription's `seq` moves. A filing outlives an unsubscribe,
so a blog resubscribed from Settings' dimmed row goes back where it was. A feed merged into
another (0028) takes its filing along, unless the member has already filed the target.

**Three mutations, each decided as its neighbours are:**

- `putFolder` makes a folder or renames one, to the later `at`, and never revives a deleted one.
  It makes none past `MAX_FOLDERS` (100), though a rename still applies at the limit.
- `deleteFolder`: delete wins, as a highlight's does. The same batch leaves its blogs in no
  folder. The filings keep their own clocks, so a move made elsewhere before the delete and
  pushed after it still lands where it went. A deleted folder takes nothing.
- `fileFeed` moves a blog to a live folder of the member's own, or to none, to the later `at`,
  through the feed a merged one became.

Names are trimmed, their runs of spaces made one, and kept to 60 characters. Settings refuses a
name the member already has: case aside, accents not, so "Cafe" and "Café" are two. The server
does not refuse one, because two devices offline may both make "Cities". An import files into a
folder of the same name.

**The protocol stays at 3.** The change is additive, as highlights and follows were:

- a shell from before ignores the new rows and has a `default:` for the new types;
- a tela-api from before refuses the new mutations as invalid, so they visibly roll back;
- a device copy written before the tables existed starts over from a snapshot.

That last rule had a hole, which 0031 accepted for follows: a tab of the earlier build left open
across the deploy shares the device's database. Once this build has written the folder tables,
that tab's pulls move the shared cursor past folder rows it drops, and the next boot finds every
table present and trusts the cursor. A follow it dropped comes back the next time the followee's
profile changes. A folder deleted, renamed or emptied elsewhere would never come back. So the copy
now records which tables the build that last moved its cursor keeps (`kept`, beside the cursor in
`apps/reader/src/store/db.ts`). An earlier build moves the cursor without it, and the next boot
starts over from a snapshot. A later build that keeps more tables is trusted. Every table a later
round adds is covered the same way.

**A folder's list is `/reading?folder=<id>`.** The address alone says which folder is open, as it
says which feed is. One that no folder has (deleted on another device, or a stale link) shows
that the folder is gone, with a link to All articles. It does not redirect, because a redirect
decided by a render replaces whichever history entry is current. Folders are listed by name, the
blogs in each by title, and the blogs in no folder come last.

**Mark all read on a folder is one `markAllRead` per blog in it**, sent as one held group, so its
Undo is all or nothing, as a feed's is (0046). A folder of more than 50 blogs goes over two
pushes. Each mark is idempotent, and no new mutation means no new protocol.

**Open or closed is per device**, in `localStorage` (`tela.folders.closed`), like the sidebar's
own state (0029). A phone and a laptop want different things open, and a click should not be a
push. Folders start open, so nothing a member files disappears from the sidebar. The 48px rail
(0030) keeps one swatch per blog, in sidebar order, and has no folder rows. To read a folder,
open the sidebar.

**Private by construction.** Folders sync only to their member and never reach a profile, a
public page or the edge. "Your data" names each blog's folder and lists the folders, empty ones
included.

**OPML carries them:**

- *Import.* A feed's folder is its nearest enclosing outline that is not a feed, by its `text`,
  else its `title`. A folder of the same name is reused, or one is made, up to the limit. Only
  blogs in no folder yet are filed, so an import never moves a blog the member placed
  themselves.
- *Export.* One outline per folder, holding its blogs, then the blogs in no folder.

## Consequences

- Settings keeps its own unsubscribe, where the row stays dimmed and can be subscribed again in
  place, rather than the design's toast. A dimmed row stays in its folder.
- Dragging is a pointer's way to move a blog, from `md` up. The folder button on each row is the
  way that works everywhere: a menu, or below `md` a bottom sheet with "+ New folder".
- A filing pointing at a folder this device no longer holds reads as no folder, until the pull
  that unfiles it arrives. The other way round, a link to a folder made on another device reads
  as gone at boot until the first pull brings it, as a link to an unknown feed shows nothing.
- A folder whose deletion is held while its Undo shows keeps its name and its place under the
  limit until the deletion goes, whether the server has it or it was made on this device and is
  still on its way (`foldersBeforeHolds`: the view with every held change taken back). Made again
  meanwhile, and the delete undone, the member would have two folders of one name, or lose one
  past the limit and every blog moved into it.
- What an OPML import writes carries no clock (`updated_at` 0), as a pref taken from a browser
  does. Stamped with the server's time, it would beat a rename or a move made just after it on a
  device whose clock runs behind.
- A folder name with a control character is refused (`invalid_name`). SQLite's `length()`
  stops at a NUL, so the table's check would sink the whole push, and the device would send it
  again, first, for ever.
- Mark all read on a folder predicts one mark per blog, each over a copy of the device's tables.
  Measured at 300 blogs of 30 posts each: about 20 ms to plan when pressed (its marks applied
  together and compared once, not once per blog, which took 100 to 130 ms), and 20 ms per
  recompute while the marks are held or pending, on a laptop. A phone is several times slower.
  That is the price of keeping the protocol. An optional `feedIds` would be worse: a tela-api
  that predates it strips the field, and reads the mark as one over every feed.
- The export groups folders by name, so two folders of one name (two devices offline) come out
  as one outline.
- Collections, blogrolls, Save and "subscribe to a blogroll into a folder" are later rounds. A
  folder holds blogs only, never posts, so collections will need their own table, not this one.
