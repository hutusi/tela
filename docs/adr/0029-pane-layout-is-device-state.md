# 0029 — Pane layout is device state, not a synced pref

Status: accepted (2026-09-30). Beside 0026, which made typography and theme synced prefs.

## Context

The reading page is three columns from `lg`: the sidebar (220px), the list (260px while an article
is open) and the article. Side by side needs the article pane's content box to reach 1080px (a
container query, ADR 0019 and DESIGN.md), which is a window of about 1624px. A 13" or 14" MacBook
window is 1440–1512px wide, so its pane is 960–1032px and every bilingual post falls back to the
interleaved layout. Hiding the sidebar makes the pane 1180–1252px: two columns of 538–574px. Hiding
the list as well is what gets two columns at 1280px.

So the reader wants to hide a pane, and the question is where that choice lives. 0026 made text
size, line length and theme synced prefs, because reading comfort is the member's and every device
should read the same way. Which panes are on screen is not that kind of choice: it depends on the
screen. The laptop that hides the sidebar shares an account with a monitor that has room for it,
and a choice synced between them is wrong on one of the two.

## Decision

**Which panes show is state of the device**, kept in localStorage (`tela.sidebar`, and `tela.focus`
for the list) behind one small store, `apps/reader/src/lib/layout.ts`, which the page reads through
`useSyncExternalStore`. Nothing about it reaches the server: no row, no mutation, nothing in the
pull.

The values keep the synced prefs' shape: names (`shown` / `hidden`, `off` / `on`), not booleans,
and a value this build does not know falls back to the default, so a later build can add a state
without breaking an earlier one. A store that cannot be read or written (private mode, a blocked
origin) leaves the defaults, and a choice made then holds for the session.

Other tabs of the same browser follow through the `storage` event, heard for the module's life
rather than per subscriber, so a tab away from the reading page has a fresh answer when it comes
back. The theme's localStorage key (0026) is unchanged: it is a first-paint cache of a synced
pref, not device state.

## Consequences

- A new device starts with every pane shown, and each device keeps its own answer.
- The e2e suite has nothing to reset: every test's context starts from the storage-state file the
  setup wrote, so a hidden sidebar cannot leak into the next spec.
- The URL still owns the open article (0017, 0025). The panes are not in it: a link opens the same
  article on any device, in that device's layout.
- There are now two kinds of UI state, and the rule for choosing between them: a preference about
  *how the member reads* syncs; one about *this screen* does not.
