# 0037 — For writers shows a labelled sample, and both headers switch light and dark

Status: accepted (2026-10-04). Supersedes two parts of 0035: For writers' example card is no
longer the owner's live `@hutusi` profile, and the visitor header gains an item. The rest of 0035
stands, including that the copy says only what Tela does.

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

**Both headers carry a light/dark switch from `sm` up.** It is a 34 px circle beside the search link
(for a member) or the Read-in pill (for a visitor), hidden below `sm`, where the visitor header has
some 35 px to spare.

- **What a press does.** It flips from the theme shown, reading `data-theme` or the system at press
  time, to the other one. It never goes back to System: that stays in Settings and the Aa menu.
- **Where it is kept.** A member's press writes the synced `ui.theme` pref, and the page then shows
  what the store makes of it, as it does for Settings and the Aa menu. A pref is settled by the
  later `at`, so a press can lose to a choice made later elsewhere, or to a clock that is behind;
  a page painted from the press would then disagree with Settings and the server for good. A
  visitor has no pref, so their press goes on the page and stays on the device.
- **The glyph comes from CSS.** The moon shows on a light page and the sun on a dark one, under the
  same selectors as the colour tokens. It is therefore right in the edge's cached HTML and before
  any script runs.
- **A visitor's choice carries into their account.** If the account has no `ui.theme` row once its
  rows arrive, and this browser shows light or dark by choice, that choice is written to the
  account once. Otherwise the account's pref wins, as before.

## Consequences

- The page no longer depends on a member's profile, so it cannot go thin when that member changes
  what they show. It fetches one public answer, `/api/v1/public/front`.
- The sample is a claim about Tela's features, not about its members. A feature it shows that Tela
  later drops must leave the sample too.
- Members can now set the theme in three places, and all of them write the one pref. The header's
  press never offers System.
- An account with no theme row, signing in on a browser where someone else chose dark, adopts dark.
  That is accepted: it is what the browser was showing.
- The member header at `sm` has the least room to spare. The nav is still its one shrinkable item,
  and it scrolls if it runs short (DESIGN.md).
