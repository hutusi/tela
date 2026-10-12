# 0047 — Phone pages: below md, Settings as a list, Profile's own address

Status: accepted (2026-10-12). Completes 0046's phones: the pages it left as next.

## Context

Tela v5 drew seventeen phone screens. 0046 shipped the reading list, the article and the account
menu (01–09 and 17) and left the rest for later: Following, a profile, a blog, Settings as a list,
the Dashboard, Search and first run (10–16). Until now those pages were their desktop layouts
squeezed into 360px. The profile's avatar sat alone on its own line. Every setting's control
wrapped under its label. The Dashboard's table scrolled inside itself. Search put its field under
its heading and gave each blog a three-line card, and first run stacked six cards.

Building them raised three questions the screens could not answer by themselves.

1. **Where a phone page starts.** The handoff says below `lg` (1024px), the reader's boundary.
   But Settings' side column and the profile's smaller avatar already switch at `md` (768px), and
   between the two both fit as they are.
2. **What `/settings` is.** It was Profile: the first section had no address of its own, and
   `/settings/profile` redirected to it. A phone's Settings is a list of sections, each behind a
   back bar, and the list needs an address.
3. **Where "Default view" lives.** Screen 13 puts it under Reading, as a row that opens something
   nobody has designed. The desktop design, like the live page, keeps it under Language.

## Decision

**Phone pages change below `md`.** The header keeps `sm`, where its width budget runs out, and the
reader keeps `lg`, where three panes stop fitting. A page with one set of controls or the other
(the Settings list or its side column, the Dashboard's rows or its table, Search's blog rows,
first run's rows and its Start bar) renders from `useMediaQuery(BELOW_MD)`, so each test id
exists once. A page the edge also renders (a profile, a blog) changes by CSS alone. The SPA
replaces the edge's HTML, so a media-query hook would paint the desktop layout first and then
jump.

**`/settings` is Settings, and Profile is `/settings/profile`.** Below `md`, `/settings` lists the
seven sections, and each section has a back bar to it under the header, as the article's back bar
sits under the header. The bar is a link, not history: a deep link arrives with none. From `md`
up, `/settings` still shows Profile beside the side column. Every link that means Profile
(Edit profile, a claim's "handle taken") names `/settings/profile`, so nobody edits a profile at
bare `/settings`, where turning a phone across 768px would swap the form for the list and lose
what was typed.

**"Default view" stays under Language** at every width. One setting has one home, and a row that
opens an undesigned page is not a design.

**Left out, on purpose:**
- "Reads in English, Swedish, Spanish" on a profile, which 0031 already refused: it would publish
  the private never-translate list.
- The Dashboard's Likes tile saying "on these posts". The tiles are whole-blog totals, not the
  twenty rows below them, so it keeps "across {n} posts".
- A lit Reading pill on Search. No pill lights there on desktop, and the nav should not depend on
  width.
- First run without the Feeds bar above it. That bar is a phone's only way to Liked.

## Consequences

- From 768 to 1023px the pages keep their desktop layouts while the reader, on the same window,
  shows its phone bars. Each layout follows its own content.
- `/settings` shows different things either side of `md`. A section's address shows the same
  section at every width, and so does Profile's, now that it has one.
- The settings row's label gives way before its control at 360px, so the size, measure and theme
  switches sit beside their labels. A control too wide still wraps under its label, as before.
