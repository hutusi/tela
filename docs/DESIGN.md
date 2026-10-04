# Design

Source of truth: the Claude Design project "Tela RSS Reader Platform"
(`https://claude.ai/design/p/faa36827-0740-4a68-83ea-7044d630ce9c`), whose `Tela.dc.html` holds the
app and `Tela Logo.dc.html` the mark. This file records what the code takes from them so the two
stay aligned.

## Tokens (`apps/reader/src/styles.css`, Tailwind `@theme`)

| Token | Value | Use |
|---|---|---|
| `paper` | `#f6f2ea` | page background |
| `ink` | `#1f1c18` | primary text, filled buttons |
| `body` | `#2a261f` | article body text |
| `ink-2` | `#5c554b` | secondary text, excerpts |
| `muted` | `#8a8275` | metadata, counts, placeholders |
| `line` | `#e3dccf` | borders |
| `hover` | `#ece6da` | hover and selected backgrounds |
| `thumb` | `#d9d2c5` | scrollbar thumb, dashed borders |
| `source` | `color-mix(hover 55%, paper)` | ground for the original beside its translation |
| `accent` | `oklch(0.50 0.10 150)` | unread dot, avatar, links, the mark's second strand |
| `accent-strong` | `oklch(0.40 0.10 150)` | link hover |

On a dark ground the green lifts to `oklch(0.68 0.14 150)` (`#4eb068`), which is where the tiled
mark takes its green from, and what `primary` becomes in dark mode. Text in the accent (links, the
italic spans) lifts a step further, to `oklch(0.74 0.12 150)`, as the design's Night page draws it
(below).

Fonts: EB Garamond (headings, article body, excerpts; 400/500/600, italic) and Figtree (UI;
400/500/600), both self-hosted from `@fontsource` (Latin and Latin Extended), so no page asks
Google Fonts for anything. CJK fallbacks: Songti SC / Noto Serif CJK SC for
serif, PingFang SC / Noto Sans CJK SC for sans. Base UI size 14px; article body 19.5px/1.55
(CJK 18px/1.8).

Motion: `animate-fade` (250 ms fade + 4px rise) on view changes and popovers. Under
`prefers-reduced-motion: reduce` the token itself becomes `none`, which covers every use at once;
`styles.e2e.ts` checks the computed `animation-name`, since that relies on Tailwind compiling
`animate-*` to `animation: var(--animate-fade)`.

## Links

`a` is accent with no underline, and `accent-strong` underlined on hover. Chrome links opt out of
both with `text-ink` and `hover:no-underline`; links inside `.article-body` are underlined at rest
in `line`, offset 3px, because prose needs an affordance the chrome does not.

The base rules live in `@layer base` in `styles.css`, and they have to. Tailwind v4 emits every
utility into `@layer utilities`, and an **unlayered** declaration outranks every layered one
whatever its specificity — so an unlayered `a { }` block silently beats the class list on every
link in the app. `styles.e2e.ts` checks the computed styles, since nothing about the JSX shows it.

## The mark

Two mirrored strands that both pass through the centre, so it balances whichever way it flips. Two
forms, and the transparent one is primary:

- **Transparent** — `LogoMark` (`apps/reader/src/components/logo.tsx`), 28px in the header lockup
  beside the wordmark. Strands in `currentColor` and `accent`, stroke 3.4 on a 48 viewBox, round
  caps. It sits on the paper; there is no badge behind it. Below `lg` the mark carries the brand
  alone, and the wordmark stays as the link's accessible name.
- **Tiled** — only where the mark needs a shape of its own: `src/app/icon.svg` (32px weight),
  `favicon.ico` (16 and 32) and `apple-icon.png` (180, square-cornered because iOS masks it
  itself). A dark `ink` tile, `rx=11`, strands in `paper` and the lifted accent, on the inset path.
  The strands thicken as the tile shrinks — 3.3 at 32px, 5.0 at 16px — so the crossing survives.

All three files come from `cd apps/reader && bun run icons`, which renders them through the Chromium
Playwright installs. Regenerate and commit them whenever the geometry changes.

## Layout rules

- Header 56px, sticky: the lockup (28px mark + wordmark, serif 26px/600, 9px apart),
  Reading/Discover/Following pills (Following for members), search, the Read-in menu ("Read in
  中文 EN", for members), and the member's avatar (30px: their picture, or their initial on the accent). A
  member's interface language is in Settings → Language, not the header. Pills are ink in every state: the active one is distinguished by its
  `hover` background alone, never by colour.
- A visitor's header (ADR 0035) is its own, shown as soon as the device is known to hold no
  member (a guest, or a session still `unknown` with no stored account), so it never waits for
  `/me`. From `sm` up: the lockup, the Discover and *For writers* pills, then "Read in EN ▾"
  (`VisitorLocale`), *Log in* as a quiet pill and *Join* filled in `primary`; below `sm` the
  lockup, the nav and Join, which at 360px leaves the two pills some 35px to spare. No Reading
  pill and no search, both a member's. "Read in" sets the interface language and with it the
  language titles are translated into, which reverses the rule of 2026-10-01 that a visitor
  changed it only on the sign-in page: the first thing a visitor needs to know is whether they can
  read the page. It is a `<details>`, so it opens in the edge's page before the script runs; choosing
  needs the script. Log in and Join are links to `/login` and `/join`, which open the sheet over the
  page once the script runs (a modified click still opens the page).
- The avatar opens the account menu (Tela v2): a 220px `surface` panel under it with the member's
  name and @handle, then Your profile, Subscriptions (`/settings/subscriptions`), Dashboard,
  Settings, Invite friends (`/settings/invites`), a rule, and Sign out in `muted`. A disclosure, not an ARIA menu: Tab reaches its items.
  Esc closes it and returns focus to the avatar, before the reader's own Esc can close an article;
  a click elsewhere or any navigation closes it too. The avatar is `shrink-0` at every width,
  since it is the only way to Settings, the Dashboard and signing out, and `styles.e2e.ts` holds it
  to 30px on screen at every header breakpoint.
- The header holds more controls than a narrow viewport fits, so it arrives in three stages:
  compact below `lg` (mark only, `gap-2.5`, search as a 34px link to `/search`), the wordmark and
  the wider desktop spacing at `lg`, the 240px search field at `xl`. Turning the wordmark and the
  field on together at one breakpoint is what previously left 768–1100px with a 4px-wide nav and a
  page that scrolled sideways.
- `SearchField` is the site's one search input, and `/search` renders it below `xl` while the
  header renders it from `xl` — exactly one is visible at any width. The page needs its own copy
  because the header's collapsed search link lands there: without it the link reaches a results
  page with nothing to type into.
- **The nav is the only control in the header allowed to shrink**, because it is the only one that
  scrolls: from `sm` up every other control is `shrink-0`, since squeezed below its one-line width
  each one wraps its label into the 56px bar instead. Below `sm` they stay shrinkable — the phone
  header has no room to spare, and a wrapped pill beats a nav with nothing left to scroll.
  `styles.e2e.ts` measures this at 640, 768, 800, 1024 and 1280: at most one pill may be clipped
  from 800 up, and none at all from 1024. The tolerance is in pills rather than pixels because the
  row measures 335px on macOS and 341px in CI's Linux Chromium. `door.e2e.ts` measures the
  visitor's header at 360, 412, 640, 768, 800, 1024 and 1280 with the same helper
  (`measureHeader` in `e2e/helpers.ts`): its nav is never clipped, and no control wraps.
- Reading view (`/reading`) is a three-column grid on `lg+`: sidebar 220px, list
  `minmax(280px, 380px)` or 260px when an article is open, main `minmax(0, 1fr)`. Sidebar and
  list are sticky and scroll independently. The sidebar collapses to a 48px rail from a toggle in
  its own header, and the rail's toggle expands it again (`[` does both). Focus (`f`, or
  the button beside Close) hides the list and the sidebar or rail while an article is open,
  which then has the grid to itself; closing brings the list back. The list stays mounted, taken out of the grid by
  an unlayered rule in `styles.css` (a `lg:hidden` would fight its own
  `lg:group-data-[open=1]:block`), so its page of rows and its scroll survive and Esc still finds
  the row it closed. Which panes show is this device's choice, kept in localStorage rather than
  synced (ADR 0029). Below `lg` the
  sidebar is hidden, a `MobileNav` disclosure above the list carries the filters, subscriptions
  and "Add a feed", and the list gives way to the reader when an article is open (stacked
  fallback: list → article as a page). Mobile is a fallback, not a design; `mobile.e2e.ts` keeps
  it working.
- Side by side is a container query on the reader pane, not a viewport breakpoint: two columns of
  up to 640px appear once the pane itself is 1040px (500px a column, ADR 0030), which is about a
  1584px viewport after the sidebar and list have taken 480, 1412px with the sidebar collapsed to
  its rail, and 1104px in focus — which is why
  a 13" or 14" laptop wants the toggle and a 1280px window wants focus; `layout.e2e.ts` measures
  both. Below that the same grid is one column
  and the pairs interleave — a source paragraph, its translation, the next paragraph — at the full
  measure. `styles.e2e.ts` measures the columns at 1280, 1440 and 1700; the previous `xl`
  breakpoint rendered 348px columns at 1280 and nothing caught it (ADR 0019).
- List rows: feed swatch (10px), feed name, relative time, `XX → EN` badge for foreign posts,
  accent unread dot, serif title (19px wide / 15.5px slim), two-line excerpt, `min · ♡ · ↗` row.
  Read rows render at 62% opacity; the open row has a white background.
- Reader: `✕ Close` left, Like (and Recommend, phase 7) right, at the pane's edges; below them
  one column, centred in the pane, holding the meta line (swatch, feed, author, time, reading
  time, original link), the translation bar, the body, the highlights and the author card (a 44px
  round swatch, site title, tagline, reader count, and the visibility note). The column is the
  member's measure (640px by default) while the body is one column, and 1240px once two paired
  columns fit, so the chrome above and below the text is as wide as the text. Serif title
  40px/1.12 alone and 32px when paired. The column is a `@container` wrapper of its own, never
  the pane: container-type brings layout containment, and the highlight toolbar and note are
  `fixed`. After the author card, an *Up next* card names the post after this one in the list as
  shown — the one `j` would open — so a pointer reader flows on without going back up the list.
- Paired reading: one grid row per top-level block, the original first — left-hand column when
  there are two, above the translation when they stack, so nothing changes places at the
  threshold. The original — its title included — sits on `source`, continuous down its column and
  a rounded panel per block when the two stack. A block whose translation failed keeps its source
  text in the translation column, behind a dashed `thumb` rule and a "not translated" label. The chosen mode is remembered
  across articles, so closing one does not send the next back to side by side.
- Swatch colors are derived from the feed id (`oklch(0.55 0.11 hue)`, hue = id × 137.508 mod 360)
  so a feed keeps its color everywhere without storing one.

## Components (`apps/reader/src/components`)

`AppHeader`, `VisitorLocale`, `FrontDoor` (the sheet and `DoorForm`), `WriterCard`, `ReadInMenu`, `Sidebar`, `ManageSubscriptions`, `MobileNav`, `ArticleList`, `Reader`,
`PairedBody`, `TranslationBar`, `Untranslated`, `LikeButton`, `RecommendPopover`, `EmptyState`,
`LogoMark`, `SearchField`, `Swatch`, `SiteAvatar`, `SiteCard`, `SiteFooter`, `TypographyMenu`, the
highlight toolbar, note and list (`highlights.tsx`), and `Shortcuts`. The front page, Discover, a
blog's page and a profile are pure views in `apps/reader/src/views`, rendered by the SPA and by
the edge alike. Anything
interactive in them must work without JavaScript or degrade to a link: Discover's language menu
is a native `<details>`, and a visitor's Subscribe is a link to sign in. The store marks read,
requests translations and follows background work itself, so no component polls or refreshes.

Recommend (from the design): the reader's action row holds Like and Recommend pills; Recommend
opens a 320 px popover with a three-line serif textarea, a hint ("shown on your profile and to the
author"), Cancel and a filled Recommend button. Success shows a bottom-centre toast for ~2.5 s
(the toast lives inside `RecommendPopover`; there is no global toast bus yet). A recommended post
renders the pill filled (`bg-ink`), and clicking it again removes the recommendation.

Settings (Tela v2): a 1040 px page, a 200 px section nav on the left (sticky from `md`, one row
that scrolls below it) holding the serif "Settings" heading, and the section in a 640 px column.
Each section is an address (`/settings`, `/settings/reading`, `/settings/translation`,
`/settings/subscriptions`, `/settings/privacy`, `/settings/invites`, `/settings/account`), so Back
and a shared link land on it. Invites and Account are the two sections that read live answers from
tela-api instead of the synced tables, on purpose: an invite list is counted by the server and holds
other people's state, and how a member signs in is security state. Invites says how many of the
five places are left, with *Create a code* (the filled button, disabled once none are left) beside
it, then the codes, newest first: each in its groups of four, with its link
(`/join?code=ABCD-EFGH-JKMN`, selectable), *Copy link* and a muted *Revoke* while unused, and
"@handle joined" (the handle a link to the profile) once used. A revoked code leaves the list and
gives its place back. Account has rows for the email, the password (*Set a password* or *Change
password*, which opens the fields under the row), Google and GitHub (only those tela-api has keys
for, or one already linked: *Link* or *Unlink*, and since when), and *Sign out everywhere*. A session
older than a day cannot change how its member signs in, so the section then opens with a `surface`
box, *Confirm it's you*, which mails a code to the member's own address and takes it right there,
since the login page sends a member straight on. Its code field and its refusals are the sheet's
(`door.codePlaceholder`, `door.errors.*`): a 429 says "too many tries" here too, never "wrong code".
`/settings/translation` is labelled Language: the
interface language comes first, each choice in its own name (English, 简体中文) so it can be found
whatever the page is in, then what posts are translated into. The interface language is the
profile's, so it follows the member to every device; the `tela_locale` cookie mirrors it for the
edge, and is all a visitor has. A section opens with a 30 px serif heading and a
muted intro; below, rows (`SettingRow`) separated by `line` rules: the label and a muted hint on the
left, the control on the right. Controls are `Segmented` (the choices on the `hover` ground, the
chosen one lifted on `surface`), `Switch` (40 × 24, `accent` on / `thumb` off, `knob`), a native
select, or a quiet pill button. Settings that change what others see say so, and that the public
profile can take a few minutes to catch up. Profile opens with the member's avatar at 64 px beside
*Upload a picture* (*Change picture* once there is one) and *Remove*, quiet pills. One picture at
a time, and only the control that decides it: while there is an upload, a muted line under the
pills says what removing it goes back to (their Gravatar, or their initial), and the Gravatar switch
is not shown, since it decides nothing then. Without one, a `SettingRow` *Use my Gravatar* follows:
the switch, on by default, and while it is on a quiet *Refresh*, with a hint saying whether
Gravatar has a picture for their email, is still being asked, or is off (ADR 0033). The design's Notifications section,
"Who can follow you" and "Delete account" are not built (ADR 0031), so they are not shown.

The crop dialog (`AvatarCrop`) is a native modal `<dialog>` on the `surface` ground: a serif title,
a muted hint, a 280 px square frame with the picture under a round mask (outside the circle dimmed),
then a zoom slider (1–4×) and Cancel / Save. Drag moves the picture, and so do the arrow keys while
the frame has focus (Shift for bigger steps); Esc cancels. Save draws the circle's square at 256 px,
as WebP where the browser encodes it and JPEG where not, and uploads that.

The front door (`FrontDoor`, ADRs 0034–0036) is one form for logging in and joining: a native
modal `<dialog>` like the crop's, 420 px on `surface` with 16 px corners, and the same form as the
page at `/login`, where a members-only page sends a visitor and the mails' links land. From the
top: the 34 px mark (in the sheet; the page has its header), a serif title (*Welcome back*, *Join
Tela*) and a line under it; when joining, the invite code; *Continue with Google* and *Continue
with GitHub*, quiet 44 px pills, only once tela-api says they are configured, then a rule with
"or"; the email; in password mode the password and *Forgot password?*; the `primary` button
(*Email me a code*, or *Log in*); and to log in, a toggle between *Log in with a password* and
*Email me a code instead*. Inputs are 44 px, 10 px corners, a `thumb` border that turns `ink` on
focus, on `paper` inside the sheet and `surface` on the page. The code step asks for the 6-digit
code, and when joining an optional *Choose a password*, set once the code has made the account. A
log-in's code step says a code is on its way *if* the address has an account or an invitation,
since the form never says which; a join's says it was sent. Each new step takes the focus to its
first field. Joining says "No code? Tela is invite-only for now: ask a member for one." and "By
joining you agree to the Terms; see Privacy.", whose links open in a new tab so the sheet and its
invite code stay; a rule then offers the other door (*New to Tela? Join*,
*Already have an account? Log in*), which the sheet switches to in place. Esc and ✕ close the
sheet unless a request is out; `/join` closes to `/`. Each error has its own words
(`door.errors.*`): too many tries is never a wrong code, the gate's refusal is never a typo, and
a provider's code nobody listed still says the provider failed. A refused Google or GitHub
sign-in comes back to the page it started on, which opens the sheet again saying why.

For writers (`/writers`, from the design's *For writers v2*): a 1120 px page. The hero is two
columns from `lg`: on the left the kicker in accent capitals, the serif title at 58 px (42 px on a
phone) with *calling card* in accent italic, a lede, and the *Make your card* form (the name, the
blog behind a muted `https://`, a line saying whether the handle is free, the `primary` *Claim your
card*); on the right the card (`WriterCard`, a `surface` card with 16 px corners), sticky. Before
the visitor types, the card is a real member's live public profile, `@hutusi` (`lib/example.ts`,
the one place it is named): picture, name, @handle, the blogs they claimed, bio, followers and
recommendations, "reads N blogs" only when their subscriptions are public, and their latest
recommendation where the design had a pinned post; with no such profile (a fresh stack), an empty
dashed outline. As they type it becomes theirs: the name, the handle suggested from it
(`lib/suggest-handle.ts`: the first name folded to `[a-z0-9_]`, the whole name when that is too
short, the blog's own name for a name with nothing Latin in it), the blog's host, and a dashed note
that recommendations and blogs read come as they use Tela. Typing pauses 400 ms before the page asks
`/api/v1/public/handles/:handle`: "✓ @x is available" in accent, or "@x is taken. Try @y." with
the suggestion a button; no answer says nothing and never holds the button back. Then *Writers find
each other here.* (the example's recommendations that carry a note, as cards; gone when there are
none), *What your card does* (01–03 under an ink rule), *How it works* (1–3 in thumb-ringed
circles), *Your site stays yours* on the `hover` ground, and the closing line with the live count
of public blogs (`/api/v1/public/front`; without it, "Where's your blog?"), whose *Make your card*
scrolls to the form and focuses the name. The copy says only what Tela does today: no pinned post,
no named readers, no "reads you too", and translation is turned off from the Dashboard, not by
removing the card. A member sees *Claim your blog* and *Your card* instead of the form.
*Claim your card* opens the sheet in claim mode, titled "Claim @handle": a join (or a log-in) that,
once the session is the member's and their handle is still the provisional `u_…`, sets the handle
and display name, then lands on `/claim?url=…` with the blog filled in, and with a note when the
handle was taken meanwhile. Where signing in outlives the sheet (Google or GitHub, a session not
yet known), the card waits in sessionStorage and the app finishes it; a refused provider reopens
the sheet with the card as it was.

A person's avatar (`PersonAvatar`) is their initial in a circle of their colour, the accent for
one's own, with their picture over it: the one they uploaded, else their Gravatar, which is on until
they turn it off and shown only once Gravatar is known to have one (ADR 0032, 0033). The initial
always renders and the picture covers it only once it has loaded, so a slow, failed or offline
load still shows a face of sorts; the picture's address comes from the server (`/avatar/…`),
never from the page.

Profile (`/@handle`, Tela v2): a 960 px column. The header is a 112 px avatar (80 px below `md`,
the accent for the member's own, their colour for anyone else's), the serif name at 46 px,
"@handle · Joined September 2026", the bio in 20 px serif, and counts ("**N** following · **N**
followers · **N** recommendations"), then a "Writes" line of their claimed blogs. On the right:
*Edit profile* on one's own, *Follow* / *Following* on another member's, and for a visitor a
*Follow* that signs in first. Below, underlined tabs as addresses (`?tab=liked`,
`?tab=subscriptions`), each with its count; Liked and Subscriptions exist only when the member
shows them. Posts are a list with a 96 px date column ("Today", "Sep 27": the reader's local
days; the edge, rendering one page for everyone, uses UTC's, so a post within the reader's offset
of midnight can change day when the app takes over), the note in italic serif, then the blog's swatch, name and language badge ("JA → EN" when the page carries the
title in the reader's language) and the title; the whole post is the link. Subscriptions are a
grid of cards. The page is edge-cached, so the member's own follow moves the followers count on
their screen at once, and their own following count comes from their device.

Following (`/following`, Tela v2): a 1120 px page, the feed beside a 280 px aside (sticky from
`lg`, below the feed on narrower screens). The serif heading and a one-line intro, then underlined
tabs All / Recommendations / Likes as addresses. Each item is a 40 px avatar beside "**Name**
verb · 2h ago": a recommendation brings its note in 21 px italic serif and a post card (blog
swatch, name and "JA → EN", a 23 px serif title, two lines of excerpt, minutes, ♡, "Read →"); a
day's likes are one card listing the posts; a day's new subscriptions are blog cards with
Subscribe. Likes and subscriptions are grouped by the viewer's local day, and the feed pages
thirty entries at a time behind "Older activity". The aside lists the people followed (from the device, no request) and a few
readers to follow, drawn only from what is public. No toasts: a Follow button changes at once.

Blog (`/s/:id`, Tela v2): a 1080 px page. The header is an 84 px avatar (20 px corners), the host
and "✓ Claimed by {name}" in accent, the title in 56 px serif (40 px on a phone), the blog's
description as an italic tagline, and "Written in Japanese · Posts weekly · N readers on Tela",
with topic chips below; on the right, *Visit site ↗* and Subscribe, and the claim link for an
unclaimed blog. The owner's topics form follows the header. Posts are the profile's list: a date
column, a 24 px serif title (translated when the page carries one), two lines of excerpt, minutes
and ♡. A 280 px aside holds *About* (the claimant's name and bio), *Readers you follow* (a stack
of avatars and "Anna and Jonas read this blog.", a member call beside the cached page) and
*From readers* (the newest notes readers left recommending its posts).

Dashboard reuses the header and a single 720–960 px column with `font-serif` headings; there is no
dedicated design for it, so it follows the Discover page's spacing and the site card's chips.

Discover card (from the design): 40 px avatar (favicon or initial), name with a green ✓ when
claimed, host, language chip, serif tagline, "Latest: …", "N readers · cadence", and a
Subscribe/Subscribed pill. Cadence is derived from posts in the last 30 days.

Front page (`views/landing.tsx`, from `Tela Landing.dc.html` Turn 2, 2A Night and 2B Day, ADR
0035): a 1280 px page with 56 px sides (16 px on a phone), at the design's line height of 1.2
wherever a size does not set its own.

- **Hero:** two columns from `lg`, 7fr and 5fr, 64 px apart, bottoms aligned. The h1 is serif 500,
  80 px from `lg` (64 px from `md`, 44 px below), line height 1, tracking −0.025em, balanced:
  "A confluence of *N independent blogs.*", the italic span in `accent` and the 400 italic
  Garamond ships; with no count yet, no number. The right column holds the 18 px `ink-2` lede and
  two pills, "Join Tela" (filled `primary`, 15 px, 13/26 px) and "Log in" (a `thumb` outline):
  links to `/join` and `/login` in the edge's page, which open the header's sheet once the app
  runs, as the header's own Join and Log in do.
- **Strip:** a `line` rule above, 18 px either side. On the left, 11 px uppercase `muted`,
  letter-spaced 0.1em: the date ("Saturday, 3 October", day before month in English) and "This
  week, N blogs wrote in M languages" (or "The latest from N blogs" when the week has none). On
  the right, "Titles in" and a `thumb`-bordered pill of two links whose active one is filled
  `ink` on `paper`, so the toggle works without JavaScript and the edge caches each mode apart
  (`?titles=translated`; Original is the default).
- **Edition:** a grid 16 px apart (two columns from `md`, three from `lg`); the lead spans two, so
  eleven posts make the lead and one card beside it, then three rows of three. A card is
  `surface` with a `line` border (`muted` on hover), radius 12, 22 px in, 210 px tall at least
  from `md`: a 10 px colour swatch (`swatchColor` of the feed), the blog's name in `ink`, and the
  post's language at the right in 11 px uppercase (its own name, "Español", while titles are as
  written; the reader's name for it, "Spanish", while they are translated); the 28 px serif title;
  the other title in 16 px serif italic `muted`; and at the foot "N min · 3h ago" and "Read →".
  The lead is 32 px in and 300 px tall, with a 48 px title (line height 1.04, balanced), the
  excerpt in 20 px serif `ink-2` up to 640 px, then the other title, and "Read the post →" in
  `accent`. Its header adds the feed's byline when the blog's name does not already say it
  (`bylineName`: RSS's `hello@site (Name)` comes down to the name); a claimed blog shows the
  claimant instead, on every card, linked to their card. The whole card is one link to the post
  (the title's link, stretched over it); the blog's and the claimant's links sit above it. A
  visitor's post opens on the blog (`PostLink`). Every title and excerpt carries its `lang`. The
  lead is the first post of three minutes or more with an excerpt. Only the edition has a
  skeleton; the copy renders at once.
- **Writers strip:** 64 px below, a `line` rule and the hero's two columns again, centred: "Write a
  blog? Make it your calling card." in 44 px serif, then 16 px `ink-2` copy and an outlined "Make
  your card" pill to `/writers`.
- **Chinese:** the main column turns off synthesized italics (`font-synthesis-style: none`), so an
  italic span or title in a script with no italic face stays upright while its Latin keeps
  Garamond's italic, and the two headlines keep words whole (`break-keep`), breaking at the comma
  rather than inside 博客.

The page's root never fades in: the edge's copy is already on screen when the SPA replaces it.
Day is the light tokens exactly, night the dark ones, which are the design's Night palette.

Footer (`components/site-footer.tsx`): under the front page and About, Privacy and Terms, in the
SPA and in the edge's copy alike, a `line` rule and the front page's 1280 px measure, 22 px tall
padding, 13 px `muted`: "Tela" in 19 px serif 600 `ink`, "© year · Made by AI Naive" (linking
https://ainaive.com, in `ink-2`), and About, For writers, Privacy and Terms on the right.

## Strings

Every user-facing string lives in `apps/reader/messages/en.json` and `zh-Hans.json` under the same
keys (`apps/reader/test/messages.test.ts` checks); components read them with use-intl (next-intl's
framework-free core). Placeholders use ICU plural syntax.

The one exception is the prose of About, Privacy and Terms, which lives in typed modules, one per
locale: `apps/reader/src/content/info/{en,zh-Hans}.ts`. It is long, it carries links, and it is
reviewed as one document per language; as message keys it would be some 150 keys of ICU-escaped
prose loaded by every screen. Each module `satisfies InfoContent` (`types.ts`), so the compiler
holds both locales to every section. Section ids are fixed English anchors (`/privacy#cookies`)
in either language. Links are written `[text](href)` and drawn by `lib/inline-links.tsx`, which
keeps only https, a path on this site or an anchor, and leaves anything else as text. The chrome
around the prose (tabs, "On this page", "The short version", "Last updated {date}") is ordinary
`info.*` messages. Change the copy with the code it describes, and `INFO_UPDATED` with the copy.

The info pages (`views/info.tsx`): tabs About · Privacy · Terms as links (the current one
`aria-current`), the kicker, the serif title and lede, "Last updated" in the locale's long date,
then an "On this page" list that sticks beside the text from `lg`, "The short version" in a
`surface` box, and the sections with serif headings that clear the 56px header (`scroll-mt-20`).

## States the reader adds

- A skeleton pane while the first sync has not landed: the article is on its way, not gone.
- "Older articles" under a list longer than 200.
- A not-found page (`notFound.*`).
- A sign-in message for too many tries (`door.errors.rate_limited`), which is not a wrong code.

## New tokens, and the dark ground (ADR 0026)

Tokens the Next app did not need, because it hard-coded them (and `knob`, which Tela v2's switches added):

| Token | Light | Dark | Use |
|---|---|---|---|
| `surface` | `#fff` | `#26221d` | cards, popovers, inputs (was `bg-white`) |
| `danger` | `oklch(0.50 0.15 25)` | `oklch(0.72 0.15 25)` | error text |
| `highlight` | `oklch(0.91 0.10 95)` | `oklch(0.50 0.09 90 / 0.55)` | a highlight's paint |
| `highlight-strong` | `oklch(0.80 0.14 90)` | `oklch(0.70 0.12 90)` | the highlight being edited |
| `knob` | `#fff` | `#ede7db` | a switch's knob, light on either track in both themes (Tela v2) |
| `primary` | `#1f1c18` | `oklch(0.68 0.14 150)` | the one filled call to action: *Join* (the header's, and the front page's *Join Tela*), the sheet's button (ADR 0035) |
| `on-primary` | `#f6f2ea` | `#1f1c18` | text on `primary` |

`primary` is ink by day, as the design's Day page has it, and the lifted green by night, as its
Night page has it: a filled ink button on the dark ground would be a pale slab, louder than
anything else on the page. `door.e2e.ts` checks the pair's computed colours in both themes.

Dark mode redefines every token on a warm near-black ground rather than adding `dark:` variants.
The values are the Night palette of the design's front page (*Tela Landing*, 2A), so the member's
app at night is the page a visitor saw: paper is the light theme's ink, and ink its paper.

| Token | Dark |
|---|---|
| `paper` | `#1f1c18` |
| `ink` | `#f6f2ea` |
| `body` | `#e6dfd2`, between `ink` and `ink-2`: 12.8:1 on paper |
| `ink-2` | `#cfc7b8` |
| `muted` | `#a39a8b`: 6.1:1 on paper, 5.7:1 on `surface` |
| `line` | `#35302a` |
| `hover` | `#2e2a24` |
| `thumb` | `#4a443a` |
| `accent` | `oklch(0.74 0.12 150)` |
| `accent-strong` | `oklch(0.80 0.12 150)` |

`data-theme="dark|light"` on `<html>` is the member's choice. Without it,
`prefers-color-scheme` decides. The two token blocks in `styles.css` must stay identical. A
literal colour in a class list (`bg-white`, `text-[oklch(…)]`) is a bug on the dark ground:
`styles.e2e.ts` checks the computed page colours in both themes.

## Reading controls

- **"Aa"** in the reader's action row, before Like, opens a 280 px popover. It holds three
  segmented choices, which Settings → Reading repeats as rows:
  - **Size:** four steps, ×0.88 / ×1 / ×1.13 / ×1.27 of the 19.5 px body (18 px for CJK).
  - **Width:** 560 / 640 / 760 px for the single column, and for a stacked pair. Two paired
    columns keep their own 640px measure.
  - **Theme:** Auto / Light / Dark.
- **Marking read and hiding read posts** are the member's (Settings → Reading). With marking on
  opening off, the open post keeps its unread dot and the action row offers *Mark as read*; liking
  a post still reads it. With read posts hidden, a list keeps every post it has shown unread or
  open during the visit, including those the catch-up pull brought after it was painted, so
  opening a post, `j` and `k` never pull it out from under them; it is gone the next time they
  come to that list. An empty list then says "all caught up", with a link back to
  the setting.
- **Translating is the member's too** (Settings → Translation). With *Translate automatically* off,
  a foreign post opens in the original, and the translation bar says "Written in Japanese." with
  a *Translate into English* button where the mode toggle would be; nothing is requested or
  fetched until it is pressed, for that post. *Never translate* lists languages the member reads
  comfortably: their posts open as written, with original titles in the lists and no badge.
- **The sidebar toggle** heads the sidebar under a "Library" label, in the small-caps heading
  style at the headings' indent, with the toggle at the row's right end and its icon on the
  counts' right edge. The glyph is a 16px panel drawn inline (Tela has no icon set), its left
  third shaded while the sidebar is shown, in the quiet button style, with `aria-expanded` for
  its state. A toggle that had focus hands it to the one in the other state.
- **Manage** sits beside the Subscriptions heading, in the sidebar and in `MobileNav`: two sliders
  drawn like the panel (`glyph.tsx`), in the toggle's quiet style, with its right edge on the
  counts' as the toggle's is on the Library row. It opens `/settings/subscriptions`, and its name
  is in its label and tooltip. The rail has none; the account menu's Subscriptions covers it.
- **The rail** is the sidebar collapsed (ADR 0030), 48px wide. From the top: the toggle, on the
  Library row's line so that it only moves sideways between states; a divider; All, Today and
  Liked as 36px icon links (three lines, a ring with a dot and a heart, drawn like the panel);
  another divider; then a 24px swatch per feed, with the list's accent dot at its top-right while
  the feed has unread posts. Names live in each link's label and tooltip. The active item has the
  `hover` ground. Both toggle rows share one sticky box (`TOGGLE_ROW`), so neither scrolls away,
  and the rail scrolls with no scrollbar, which would take a third of its width. 48px, not the
  60 the design drew, because 60 would put a 1440px window under the side-by-side threshold. The
  sidebar and the rail exist from `lg` only; below it `MobileNav` holds the filters.
- **Focus** sits beside `✕ Close` in the action row: one label, `aria-pressed` and the `hover`
  ground while it is on, as a toggle button has. From `lg` only, since below it the list already
  gives way to the article. Both are device state (ADR 0029).
- **Highlights** are a marker stroke over the text, never a box: `::highlight()` paint, no
  element around the words.
  - A selection in the article shows a floating pill above it (*Highlight*, *Add a note*).
  - Clicking painted text opens a 320 px note popover: the quote under a `highlight-strong` rule,
    a three-line serif textarea, *Remove highlight*, *Cancel* and *Save*, as Recommend's does.
  - Under the article, *N highlights* lists each quote (in a `<mark>` there, since it is a copy)
    with its note. One the post lost says so in `muted`; one on a layout not showing says where
    it is.
- **Keys:** `?` opens a small card listing `j`, `k`, `Esc`, `h`, `[`, `f` and `?` in `kbd` chips. `[`
  needs AltGr or Option on some non-US layouts, as `?` does on others; neither is worked around.
