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

On a dark ground the accent lifts to `oklch(0.68 0.14 150)` (`#4eb068`), which is where the tiled
mark takes its green from, and what `accent` becomes in dark mode (below).

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
  Reading/Discover/Dashboard/Settings pills, search, Read-in menu, locale switcher, avatar (accent
  circle with initial, links to the profile) and sign-out. Pills are ink in every state: the active
  one is distinguished by its `hover` background alone, never by colour.
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
  row measures 335px on macOS and 341px in CI's Linux Chromium.
- Reading view (`/reading`) is a three-column grid on `lg+`: sidebar 220px, list
  `minmax(280px, 380px)` or 260px when an article is open, main `minmax(0, 1fr)`. Sidebar and
  list are sticky and scroll independently. The sidebar hides from a toggle in its own header and
  comes back from one at the head of the list (`[` does both), and the grid drops its first
  column with it. Focus (`f`, or
  the button beside Close) hides the list as well while an article is open, which then has the
  grid to itself; closing brings the list back. The list stays mounted, taken out of the grid by
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
  1584px viewport after the sidebar and list have taken 480, 1364px once the sidebar is hidden,
  and 1104px in focus — which is why
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

`AppHeader`, `LocaleSwitcher`, `ReadInMenu`, `Sidebar`, `MobileNav`, `ArticleList`, `Reader`,
`PairedBody`, `TranslationBar`, `Untranslated`, `LikeButton`, `RecommendPopover`, `EmptyState`,
`LogoMark`, `SearchField`, `Swatch`, `SiteAvatar`, `SiteCard`, `TypographyMenu`, the highlight
toolbar, note and list (`highlights.tsx`), and `Shortcuts`. Discover, a blog's page and a profile
are pure views in `apps/reader/src/views`, rendered by the SPA and by the edge alike. Anything
interactive in them must work without JavaScript or degrade to a link: Discover's language menu
is a native `<details>`, and a visitor's Subscribe is a link to sign in. The store marks read,
requests translations and follows background work itself, so no component polls or refreshes.

Recommend (from the design): the reader's action row holds Like and Recommend pills; Recommend
opens a 320 px popover with a three-line serif textarea, a hint ("shown on your profile and to the
author"), Cancel and a filled Recommend button. Success shows a bottom-centre toast for ~2.5 s
(the toast lives inside `RecommendPopover`; there is no global toast bus yet). A recommended post
renders the pill filled (`bg-ink`), and clicking it again removes the recommendation.

Profile (`/@handle`), dashboard and settings reuse the header and a single 720–960 px column with
`font-serif` headings; there is no dedicated design for them, so they follow the Discover page's
spacing and the site card's chips.

Discover card (from the design): 40 px avatar (favicon or initial), name with a green ✓ when
claimed, host, language chip, serif tagline, "Latest: …", "N readers · cadence", and a
Subscribe/Subscribed pill. Cadence is derived from posts in the last 30 days.

## Strings

Every user-facing string lives in `apps/reader/messages/en.json` and `zh-Hans.json` under the same
keys; components read them with use-intl (next-intl's framework-free core). Placeholders use ICU
plural syntax.

## States the reader adds

- A skeleton pane while the first sync has not landed: the article is on its way, not gone.
- "Older articles" under a list longer than 200.
- A not-found page (`notFound.*`).
- A sign-in message for too many tries (`login.errors.rate_limited`), which is not a wrong code.

## New tokens, and the dark ground (ADR 0026)

Three tokens the Next app did not need, because it hard-coded them:

| Token | Light | Dark | Use |
|---|---|---|---|
| `surface` | `#fff` | `#1f1c17` | cards, popovers, inputs (was `bg-white`) |
| `danger` | `oklch(0.50 0.15 25)` | `oklch(0.72 0.15 25)` | error text |
| `highlight` | `oklch(0.91 0.10 95)` | `oklch(0.50 0.09 90 / 0.55)` | a highlight's paint |
| `highlight-strong` | `oklch(0.80 0.14 90)` | `oklch(0.70 0.12 90)` | the highlight being edited |

Dark mode redefines every token on a warm near-black ground rather than adding `dark:` variants:

| Token | Dark |
|---|---|
| `paper` | `#16140f` |
| `ink` | `#ede7db` |
| `body` | `#ddd6c8` |
| `ink-2` | `#b1a999` |
| `muted` | `#8c8476` |
| `line` | `#34302a` |
| `hover` | `#29251f` |
| `thumb` | `#454038` |
| `accent` | `oklch(0.68 0.14 150)`, the lifted green above |
| `accent-strong` | `oklch(0.78 0.12 150)` |

`data-theme="dark|light"` on `<html>` is the member's choice. Without it,
`prefers-color-scheme` decides. The two token blocks in `styles.css` must stay identical. A
literal colour in a class list (`bg-white`, `text-[oklch(…)]`) is a bug on the dark ground:
`styles.e2e.ts` checks the computed page colours in both themes.

## Reading controls

- **"Aa"** in the reader's action row, before Like, opens a 280 px popover. It holds three
  segmented choices, which Settings repeats under *Appearance*:
  - **Size:** four steps, ×0.88 / ×1 / ×1.13 / ×1.27 of the 19.5 px body (18 px for CJK).
  - **Width:** 560 / 640 / 760 px for the single column, and for a stacked pair. Two paired
    columns keep their own 640px measure.
  - **Theme:** Auto / Light / Dark.
- **The sidebar toggle** heads the sidebar while it is shown: a "Library" label in the
  small-caps heading style at the headings' indent, and the toggle at the row's right end, its
  icon on the counts' right edge. The row is sticky, so a long list never scrolls it away. While
  the sidebar is hidden the toggle heads the list instead, left of its title. A toggle that had
  focus hands it to the one in the other place. The glyph is a 16px panel
  drawn inline (Tela has no icon set), its left third shaded while the sidebar is shown, in the
  quiet button style, with `aria-expanded` for its state. From `lg` only; below it `MobileNav`
  holds the filters.
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
