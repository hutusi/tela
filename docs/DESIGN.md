# Design

Source of truth: the Claude Design project "Tela RSS Reader Platform"
(`https://claude.ai/design/p/faa36827-0740-4a68-83ea-7044d630ce9c`), whose `Tela.dc.html` holds the
app and `Tela Logo.dc.html` the mark. This file records what the code takes from them so the two
stay aligned.

## Tokens (`apps/web/src/app/globals.css`, Tailwind `@theme`)

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
mark takes its green from. It is not a token: nothing in the app has a dark ground.

Fonts: EB Garamond (headings, article body, excerpts; 400/500/600, italic) and Figtree (UI;
400/500/600), both self-hosted by `next/font`. CJK fallbacks: Songti SC / Noto Serif CJK SC for
serif, PingFang SC / Noto Sans CJK SC for sans. Base UI size 14px; article body 19.5px/1.55
(CJK 18px/1.8).

Motion: `animate-fade` (250 ms fade + 4px rise) on view changes and popovers.

## Links

`a` is accent with no underline, and `accent-strong` underlined on hover. Chrome links opt out of
both with `text-ink` and `hover:no-underline`; links inside `.article-body` are underlined at rest
in `line`, offset 3px, because prose needs an affordance the chrome does not.

The base rules live in `@layer base` in `globals.css`, and they have to. Tailwind v4 emits every
utility into `@layer utilities`, and an **unlayered** declaration outranks every layered one
whatever its specificity — so an unlayered `a { }` block silently beats the class list on every
link in the app. `styles.e2e.ts` checks the computed styles, since nothing about the JSX shows it.

## The mark

Two mirrored strands that both pass through the centre, so it balances whichever way it flips. Two
forms, and the transparent one is primary:

- **Transparent** — `LogoMark` (`apps/web/src/components/logo.tsx`), 28px in the header lockup
  beside the wordmark. Strands in `currentColor` and `accent`, stroke 3.4 on a 48 viewBox, round
  caps. It sits on the paper; there is no badge behind it. Below `lg` the mark carries the brand
  alone, and the wordmark stays as the link's accessible name.
- **Tiled** — only where the mark needs a shape of its own: `src/app/icon.svg` (32px weight),
  `favicon.ico` (16 and 32) and `apple-icon.png` (180, square-cornered because iOS masks it
  itself). A dark `ink` tile, `rx=11`, strands in `paper` and the lifted accent, on the inset path.
  The strands thicken as the tile shrinks — 3.3 at 32px, 5.0 at 16px — so the crossing survives.

All three files come from `cd apps/web && bun run icons`, which renders them through the Chromium
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
  list are sticky and scroll independently. Below `lg` the sidebar is hidden, a `MobileNav`
  disclosure above the list carries the filters, subscriptions and "Add a feed", and the list gives
  way to the reader when an article is open (stacked fallback: list → article as a page). Mobile is
  a fallback, not a design; `mobile.e2e.ts` keeps it working.
- Side by side is a container query on the reader pane, not a viewport breakpoint: two columns of
  640px appear once the pane itself is 1080px, which is about a 1624px viewport after the sidebar
  and list have taken 480. Below that the same grid is one column and the pairs interleave —
  translation, its original, next paragraph — at the full measure. `styles.e2e.ts` measures the
  columns at 1280, 1440 and 1700; the previous `xl` breakpoint rendered 348px columns at 1280 and
  nothing caught it (ADR 0019).
- List rows: feed swatch (10px), feed name, relative time, `XX → EN` badge for foreign posts,
  accent unread dot, serif title (19px wide / 15.5px slim), two-line excerpt, `min · ♡ · ↗` row.
  Read rows render at 62% opacity; the open row has a white background.
- Reader: `✕ Close` left, Like (and Recommend, phase 7) right; meta line with swatch, feed,
  author, time, reading time, original link; serif title 40px/1.12 alone and 32px when paired;
  body max 640px; author card with a 44px round swatch, site title, tagline, reader count, and the
  visibility note.
- Paired reading: one grid row per top-level block, translation first. The original — its title
  included — sits on `source`, continuous down the second column and a rounded panel per block
  when the two stack. A block whose translation failed keeps its source text in the translation
  column, behind a dashed `thumb` rule and a "not translated" label.
- Swatch colors are derived from the feed id (`oklch(0.55 0.11 hue)`, hue = id × 137.508 mod 360)
  so a feed keeps its color everywhere without storing one.

## Components (`apps/web/src/components`)

`AppHeader`, `LocaleSwitcher`, `ReadInMenu`, `Sidebar`, `ArticleList`, `Reader`, `PairedBody`,
`TranslationBar`, `LikeButton`, `MarkRead`, `RequestTranslation`, `AutoRefresh`, `EmptyState`,
`LogoMark`, `SearchField`, `Swatch`, `SiteAvatar`, `SiteCard`, `RecommendPopover`. Discover's hero, topic chips,
language menu (a native `<details>` dropdown), and claim banner live in `app/discover/page.tsx`.

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

Every user-facing string lives in `apps/web/messages/en.json` and `zh-Hans.json` under the same
keys; components read them with next-intl. Placeholders use ICU plural syntax.
