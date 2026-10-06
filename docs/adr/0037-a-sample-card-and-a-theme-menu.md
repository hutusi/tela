# 0037 — For writers shows a labelled sample, and both headers choose the theme

Status: accepted (2026-10-04). Supersedes three parts of 0035: For writers' example card is no
longer the owner's live `@hutusi` profile, the visitor header gains a theme menu, and a visitor's
Read in is the member's pill rather than a dropdown. The rest of 0035 stands, including that the
copy says only what Tela does. Superseded in part by 0040 (2026-10-07): both headers carry one
language circle, not the Read-in pill.

## Context

After the design-fidelity pass (PR #25), `/writers` matched the Claude Design in layout, but not in
what it said. Its example card was the owner's live public profile, which through the private beta
had no bio, no claimed blog, no recommendation with a note, private subscriptions and likes, no
followers and one recommendation. So the card was three lines long. Every section under it was
drawn only when it had something true to show, so they hid too: the activity card showed one post,
and the blogroll and readers sketches did not appear. Rendered with that profile filled in, the
page came close to the design. Even then, one member cannot show what the design's activity card
shows, a Following page of several writers, and a follower count of zero argues against joining.

Members could choose a theme (System, Light, Dark) in Settings and in the reader's Aa menu, a synced
pref since 0026. Visitors could not: they followed their system, and the device's last choice
survived only because the inline script in `index.html` reads it.

## Decision

**For writers shows a sample, and says so.** The card is the design's cast: Lucía Ferrer of
Kilómetro Cero, followed by Tom Adeyemi, Priya Nair and 佐藤 恵 (`lib/sample-card.ts`, the one place
they are named). The sections under it draw from the same sample: Following (with the three kinds
of row the real page has, newest first), a blogroll, and a readers card.

- **It is labelled.** The caption reads "An example card" and the activity card's label reads
  "Following · for example".
- **It shows only what Tela does.** It has no pinned post, no "Reads you too" and no named readers,
  and its counts are modest (48 followers, 24 blogs read).
- **None of it links.** Not the name, the Follow pill, a post, nor the "Find me on Tela" pill:
  `/@lucia` may be a real member's one day. The blog's host, `kilometrocero.blog`, resolves nowhere.
  The design's `.es` domain is a parked one.
- **Titles are in the catalogs, in each locale.** Tela shows a post's title in the reader's
  language, so a zh-Hans reader sees them translated. The bio and the notes stay as written,
  because Tela does not translate those either.
- **The one live fact is how many blogs are public.** It stays in the closing line.

**Both headers carry a theme menu from `sm` up.** It is a 34 px circle beside the search link (for
a member) or the Read-in pill (for a visitor), hidden below `sm`, where the visitor header has some
35 px to spare. A first version was a two-state switch, flipping between light and dark; a visitor
who pressed it once could never follow their system again, having no Settings to go back to Auto
from. The menu offers the three choices Settings does.

- **What it offers.** Auto, Light and Dark, in a `<details>` like the account menu's panel. Its
  circle shows the current choice: a half-filled circle, a sun or a moon.
- **Where a choice is kept.** A member's choice writes the synced `ui.theme` pref, and the page then
  shows what the store makes of it, as it does for Settings and the Aa menu. A pref is settled by
  the later `at`, so a choice can lose to one made later elsewhere, or to a clock that is behind;
  a page painted from the choice would then disagree with Settings and the server for good. A
  visitor has no pref, so their choice goes on the page and stays on the device.
- **The glyph comes from CSS.** The stylesheet shows the one `data-theme` names, which the inline
  script puts on before anything paints, so the edge's one cached page is right for every visitor.
  For the same reason the edge marks no item as chosen; the app marks the one the page is set to.
- **A visitor's choice carries into their account.** If the account has no `ui.theme` row once its
  rows arrive, and this browser chose light or dark, that choice is written to the account once.
  Otherwise the account's pref wins, as before. (Amended 2026-10-07, review.) The rows that
  "arrive" include the copy the device kept, loaded before this visit's first pull, which can
  predate a theme chosen elsewhere since; written as an ordinary pref stamped now, the adoption
  beat that choice by its clock. It is now `setPref {ifAbsent: true}`: tela-api writes it only
  where the account has no row, with no clock (`updated_at` 0), so any choice made anywhere beats
  it, and the prediction does the same. A tela-api that predates the flag strips it and writes
  the pref as a choice, as before.

**A visitor's Read in is a member's pill.** 0035 gave visitors "Read in EN ▾", a dropdown that sets
the interface language, while members had "Read in 中文 EN", two buttons that set the reading
language. Same words, two shapes. With two interface languages, both in view and one press beats a
menu, so a visitor gets the member's pill (`ReadInPill`), setting what it set before. The controls
on the header's right are one family: 34 px tall and round, on `surface`, in a `line` border.

## Consequences

- The page no longer depends on a member's profile, so it cannot go thin when that member changes
  what they show. It fetches one public answer, `/api/v1/public/front`.
- The sample is a claim about Tela's features, not about its members. A feature it shows that Tela
  later drops must leave the sample too.
- Members can now set the theme in three places, and all of them write the one pref and offer the
  same three choices.
- An account with no theme row, signing in on a browser where someone else chose dark, adopts dark.
  That is accepted: it is what the browser was showing.
- A visitor's Read in is some 33 px wider than the dropdown was. The visitor header still has
  57 px to spare at 640 px; the member header, the tighter, keeps 38 px, its pill at 12 px text
  until `lg`.
- The member header at `sm` has the least room to spare. The nav is still its one shrinkable item,
  and it scrolls if it runs short (DESIGN.md).
