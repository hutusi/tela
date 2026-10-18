# 0049 — Settings › Subscriptions as a manager, and when each blog last posted

Status: accepted (2026-10-18). Supersedes 0048's Settings consequences: the dimmed row a blog left
from Settings kept, and dragging onto sections from `md` up. Its tables, mutations, sidebar and
OPML stand.

## Context

0048 built Settings › Subscriptions as one section per folder, with a folder button and a drag
handle on each row. That is fine for eight blogs and tiring at forty: nothing moves several blogs
at once, nothing finds one by name, and nothing says which blogs have gone quiet, which is what a
member pruning their list wants to know. The owner redrew the page in Claude Design (Tela Lists,
"Manage folders"), had it reviewed, and had it revised:

- **From `lg` up, two panes in one card.** On the left are the places a blog can be in: All blogs,
  Not in a folder, then each folder with its count, a "+" to make one, and a footer saying how a
  blog moves.
- **On the right, the blogs of the place chosen,** filtered by name or address and sorted A to Z,
  Recently posted or Quiet longest. Each row has its folder as a button (Move to, and Unsubscribe
  under a rule) and when the blog last posted.
- **Select / Done turns on tick boxes.** A click ticks a row and Shift-click ticks a run. The
  column heads become a bar: "3 selected", Move to (with "New folder with these…"), Unsubscribe and
  Clear.
- **Out of Select mode a row only drags,** and dragging a ticked row in Select mode drags them all.
- **Every move and every unsubscribe says so, with Undo.** A folder made with blogs in it says so
  too, without an Undo, as the design draws it.
- **On a phone, the page that shipped:** sections, a folder button that opens Move to as a sheet,
  and a ··· per folder.

The review's points the owner accepted:

- the card grows with its rows rather than scrolling inside a fixed height;
- 768–1023 px is the phone page;
- the phone page gets the filter;
- no accent dot on Not in a folder;
- the latest post comes from the server.

## Decision

**Two layouts, switched at `lg`.**

- **From 1024 px, the manager** (`components/subscriptions-manager.tsx`).
- **Below 1024 px, the sections** (`components/folders-manage.tsx`), with a filter above them.
  Moves go through the sheet, and Rename and Delete through ···. Between 768 and 1023 px this sits
  in Settings' side column, so New folder is in the page rather than a back bar.

768 to 1023 px is mostly a tablet held upright, where touch targets and a sheet serve better than
dragging. The manager does not fit there either: with the design's own measures the rows get
389 px at 768, the grid gives Latest post nothing, and the toolbar takes two lines. The `md`
variant 0048 built (sections you drag onto, buttons on each heading) goes, leaving two layouts
to keep rather than three.

**The card grows with its rows.** Its pane and toolbar stick under the header, so the places to
drop on stay in view, and the page scrolls as every page does. A fixed-height card leaves a short
list a tall empty box, and gives a long one a second scrollbar. The card does not clip its overflow
(`hidden` or `clip`), since that would cut off the menu of a row near its foot. The pieces at its
corners are rounded instead.

**Select mode.** A row is something to drag until the member asks to select, so a click is never
both a tick and the start of a drag.

- The tick boxes are real checkboxes named by the blog.
- The box over them is `indeterminate` while some are ticked; pressed then, it clears, and
  otherwise it ticks every row shown.
- Ticks survive a change of filter, so blogs can be gathered across several, and the bar counts
  the ones the filter hides ("3 selected, 1 hidden by the filter") rather than acting on rows the
  member cannot see.
- A Shift-click whose run start the filter or the order has hidden toggles as a click does.
- Esc leaves Select mode only once nothing nearer has taken it: a menu, a form, or the filter, which
  clears first.

**Changes, each held while its toast offers Undo** (0046):

- **A move** is one `fileFeed` for each blog not already in the target, held as one group. A late
  Undo files each blog back to the folder it came from, if that folder is still there, and to none
  otherwise.
- **An unsubscribe** is one `unsubscribe` per blog. The row goes, as the design has it. The dimmed
  row 0048 kept cannot work for a bulk unsubscribe, nor beside a filter that would hide it. A late
  Undo subscribes again, and since a filing outlives an unsubscribe, the blog goes back where it
  was. The phone page does the same, so one page does not behave two ways.
- **A folder's deletion** is as 0048 has it. The manager then looks at Not in a folder, where its
  blogs went.

**When a blog last posted** is the later of two dates:

- the feed row's `lastItemAt`, which the pull now sends: `feeds.last_item_at`, the newest item the
  feed listed when last fetched;
- the newest post the device holds.

The device's 30-day horizon alone cannot tell "quiet for ten months" from "quiet for five weeks".
Every fetch writes the feed through `updateFeed`, which stamps its `seq`, so devices learn the date
at each feed's next fetch without a snapshot. The field is optional, since an older tela-api and
rows stored before lack it, so there is no `MIN_CLIENT` bump.

- A `dead` feed reads "Not updating", whatever its last date, and a blog with no date at all reads
  "No posts yet". Quiet longest lists those first.
- Past 60 days the date is muted.
- The age is `Intl.RelativeTimeFormat` with `numeric: 'auto'` ("Last week", "2 months ago",
  "上个月"), so the four interface languages need no catalogue strings for it.
- It replaces the 30-day cadence ("quiet lately") on the phone rows too. That cadence had needed
  the dimmed rows to remember their counts.

**The filter** matches the query against the blog's name, its address and its feed's, with accents
and case set aside, so "velo" finds "Vélo du Dimanche".

## Consequences

- **The Settings frame is 1280 px for every section** (nav `clamp(136px, 14vw, 184px)`), so the nav
  does not move between sections. Only Subscriptions, from `lg` up, gives up the 640 px column.
- **The sheet is 560 px wide from `md` up,** centred, now that 768–1023 px opens it.
- **Undo needs no new protocol:** a bulk move or unsubscribe is many small mutations held as one,
  as a folder's Mark all read is. Undone, nothing reaches tela-api.
- **Blogs a member left are not listed in Settings.** Following one again is its blog page's
  Subscribe, or the late Undo.
- **The phone page has no bulk actions.** OPML is the bulk way in, and the desktop manager the bulk
  way to reorganise.
