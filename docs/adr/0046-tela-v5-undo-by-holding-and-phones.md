# 0046 — Tela v5: Undo by holding a change, the rail below 1200px, first run, merged highlights, phones

Status: accepted (2026-10-11). Amends 0029: an article opened below 1200px starts with the rail
when the device holds no choice. Amends DESIGN.md's "mobile is a fallback, not a design".

## Context

Claude Design's Tela v5 handoff (a README, a checklist, and the desktop and phone prototypes) is a
pass over the whole reader: contrast, naming and icons, a first-run screen, a fuller Dashboard,
translation and highlight states, the end of an article, and phone layouts. Most of it is visual
and lands as DESIGN.md says. Five parts change how something behaves, and each had a question the
design could not answer by itself.

1. **Undo for Mark all read**, and for Remove highlight. A mark-all moves each feed's watermark,
   and the watermark never moves back (0025): a later change cannot undo an earlier one by
   lowering it. Changes are pushed a quarter-second after they are made, so by the time the toast
   is read the server has it.
2. **The rail below 1200px.** Between `lg` and 1200px, three panes leave the article about 540px.
   0029 says a new device starts with every pane shown.
3. **First run.** A member with no subscriptions saw "Nothing here yet." The design shows six
   blogs to subscribe to, but draws them from its own sample data: there was no source.
4. **Overlapping highlights.** Each highlight was its own row, so a passage highlighted twice was
   two highlights, two notes and two rows in the list.
5. **Phones.** DESIGN.md called the layout below `lg` a fallback. The design draws seventeen phone
   screens.

## Decision

**A change that offers Undo is held on the device before it is sent.** `LocalStore.mutate(input,
{ holdMs })` applies it to the view at once, as every change is, but keeps it in this tab's memory
only, out of IndexedDB and out of the push, for `UNDO_HOLD_MS` (six seconds, a second longer than
the toast). Undo retracts it, and the server never hears of it. When the hold ends it is written
and sent like any other change. Held in memory, not storage, because every tab loads pending
changes from IndexedDB, and one that booted during the hold would send it; a crash during the
hold therefore drops the change, which for a mark-all or a removal is the safe way to lose it. A
held change also holds back everything queued after it, so a `subscribe` made in those seconds is
never pushed ahead of an all-feeds mark-all whose watermark would then cover it. Leaving the page
(`pagehide`, hidden) and stopping the engine release every hold first. If Undo is pressed after
the change went out anyway, it sends the inverse: a `markUnread` per post the mark-all covered (at
most 200), or the highlight again under a new id, since a deleted highlight's id stays deleted.
This needs no protocol change.

**Below 1200px, an open article starts with the rail.** The stored choice still wins: the device
holds one once the member presses `[` or the toggle, and pressing either stores the opposite of
what is shown, whichever way it came to be shown. With nothing stored, the sidebar is shown with
the list and collapses to the rail when an article opens below 1200px, following the window as it
is resized rather than latching, so no second owner of the layout appears.

**First run suggests the first six blogs of the public directory**, in its own order, which puts
featured blogs first (`/api/v1/public/discover`, the Blogs tab's first page and its cache). No
answer says which blogs are featured (0041), and none needs to. It shows only once the device has
the account's rows, so an existing member never sees it flash before the first pull, and it stays
up through the first subscriptions until the member chooses to start reading.

**A highlight that overlaps or touches another in the same paragraph merges with it.** The union
is a new highlight, under a new id, with the notes joined in reading order; the old ones are
deleted in the same change. A new id, because a stale write from another device to an old id
would otherwise undo the merge, and a deleted id cannot be brought back. A merge that would pass
the quote or note limit is not made.

**Phones are a designed layout.** Below `lg`, the article has a back bar and a bottom bar (Like,
Recommend, Mark unread, Original), Recommend opens as a sheet, and the highlight toolbar sits below
the selection, clear of the system's own menu. Below `sm`, language, theme and search live in the
account menu for members and in the footer for visitors. The phone pages after that (Following, a
profile, a blog, Settings as a list, Dashboard, Search, first run) are designed and come next.

## Consequences

- An undone mark-all costs nothing anywhere: the server never applied it.
- For six seconds after a mark-all or a removal, nothing this tab does reaches the server or
  another tab. A reader who closes the tab in that time keeps the change (leaving releases it);
  one whose browser crashes loses it.
- Changes made after a held one are written to IndexedDB at once, though this tab holds them back.
  A second tab that boots inside the hold can load and send one of them, say a `subscribe`,
  ahead of the held mark-all. Closing that gap would mean holding back their writes too, and
  losing them in a crash; it needs a tab to start in a six-second window, so it stays open.
- A post undone after its mark-all went out counts as marked unread by hand (0009), which
  outlives the 30-day horizon until it is read.
- A 1100px window opens articles beside the rail, unless the member has chosen otherwise on that
  device.
- First run depends on the network, as Discover does; offline, it offers Discover and an OPML
  import instead.
