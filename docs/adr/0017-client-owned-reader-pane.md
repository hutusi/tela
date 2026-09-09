# 0017 — Client-owned reader pane after the first render

Status: accepted (2026-09-08). Amends ADR 0016, whose one-database-wave render budget stands.

## Context

ADR 0016 reduced an article click from as many as five renders to one. Production measurement then
showed that one `/reading` React server render used about 67 ms of CPU against the Workers Free
budget of 10 ms. Repeated article opens eventually produced Error 1102. A route handler returning
only the pane's data used about 20 ms and avoided rendering the unchanged sidebar and article list.

The selected article and translation view must remain linkable. Plain links must still work before
hydration, in a new tab, and when JavaScript fails; Back and Forward must restore the same article
and display mode.

## Decision

- A direct `/reading?article=…` request remains server-rendered. After hydration, `ReadingShell`
  owns the open pane and intercepts ordinary left-clicks on article anchors.
- An intercepted click writes the real article URL with the native History API and fetches
  `/api/reading/article?article=&lang=`. Modified clicks and unhydrated anchors navigate normally.
- The URL is authoritative for the article and display mode. Filter and subscription navigations
  without `article` close the pane; Back and Forward load the article named by their history entry.
  That rule lives in `apps/web/src/lib/reader-navigation.ts` as a pure function over (what the URL
  asks for, what the server just said, what the pane is doing), and `ReadingShell` does what it
  says. It is not spread across effects, because three review passes found a coordination bug each
  time it was — most sharply when Back onto a `pushState` entry made Next replay the payload from
  before the article was opened, and the shell believed it over the URL.
- The server passes an explicit empty, ready, or gone state so a missing direct link is not confused
  with a page where no article was requested.
- Waiting for translation or extraction still polls `/api/reading/state`, but a changed revision
  re-fetches the pane endpoint instead of calling `router.refresh()`.
- A failed pane request reloads its current URL, preserving the filter, feed, article, and mode.

## Consequences

- Opening another article and observing a terminal background result perform no `/reading` server
  render. The sidebar and list stay mounted, and only the pane crosses the network.
- Server navigations and explicit refreshes remain authoritative and replace client pane state.
- The sidebar's aggregate counts retain the deliberate staleness accepted in ADR 0016.
- What a navigation used to give away has to be done deliberately: a new article scrolls to the top
  and takes focus, the selected row's dimming and unread dot follow the data attributes the shell
  maintains rather than the server's render, and the article timestamp is formatted on the server
  because `relativeTime` reads the clock and the local time zone — running it again on hydration
  can disagree with the render by a threshold or by a day.
- `/api/reading/article` is authenticated, validates the article and reading language, disables
  caching, and returns only the fields the client pane renders.
- Alternatives considered: keeping App Router navigation (still pays the React CPU cost); making
  rows buttons (loses link behavior and progressive enhancement); storing selection outside the URL
  (breaks sharing and browser history).
