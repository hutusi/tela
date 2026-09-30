# 0030 — A collapsed sidebar is a rail, and side by side starts at 1040px

Status: accepted (2026-09-30). Amends 0019, whose two-column threshold moves from 1080px to
1040px, and 0029, whose hidden sidebar becomes a rail. Pane state is still device state as 0029
decided, and it is stored under the same names.

## Context

0029 let the reader hide the sidebar, and the grid dropped its column. That is what gave a 13" or
14" laptop window (1440–1512px) its two bilingual columns. Hiding also took the filters and the
feeds off screen: getting to another feed meant opening the sidebar again.

The Tela v2 design collapses the sidebar instead. What stays is a narrow rail that holds the
toggle, icons for All, Today and Liked, and each feed's swatch with a dot while it has unread
posts. The design draws it 60px wide.

That width is what matters. With an article open at 1440px, the list takes 260px. A 60px rail
leaves the reader pane a 1056px content box, or 1041px with a 15px scrollbar, the size CI's
Linux Chromium and a Mac with a mouse attached both show. Side by side needed 1080px (0019), so
a rail as drawn would give those windows back the interleave. With the sidebar hidden they had a
1116px box and 36px to spare.

## Decision

**The collapsed sidebar is a 48px rail.** It holds the toggle, the three filters and one swatch
per feed, and it scrolls, with the toggle held at its top. It is the narrowest width that still
fits the design's 36px buttons and 24px swatches with even margins. Focus (0029) removes it along
with the list, and it exists from `lg` up only, like the sidebar it stands for.

**Side by side starts at a 1040px content box, not 1080.** The two columns then have a floor of
500px instead of 520, which is the width `styles.e2e.ts` already required of any column.
At 1440px with the rail, the box is 1068px, or 1053px with a scrollbar. That is 28px and 13px
over the new threshold, and the two columns come to about 514px and 506px.

`tela.sidebar` keeps its values, and `hidden` now renders the rail, so no device loses the
choice it made.

## Consequences

- Two columns appear from a window of about 1584px with everything shown, 1412px with the
  sidebar collapsed and 1104px in focus. The old figures were 1624, 1404 and 1144.
- A column at the threshold is 20px narrower than it was: about 55 characters of English body
  text at the default size. The original's column loses another 32px to the padding of its
  source panel. That is narrower than the 560px single-column measure, and accepted as the cost
  of seeing the original beside the translation on a laptop.
- The rail, not the list, holds the expand toggle, so the toggle only ever moves sideways
  between the two states.
- The rail spends 48px of every collapsed layout on navigation. A layout that needs more room
  than that has focus.
