# Design

Source of truth: the Claude Design project "Tela RSS Reader Platform"
(`https://claude.ai/design/p/faa36827-0740-4a68-83ea-7044d630ce9c?file=Tela.dc.html`). This file
records what the code takes from it so the two stay aligned.

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
| `accent` | `oklch(0.50 0.10 150)` | unread dot, avatar, links |

Fonts: EB Garamond (headings, article body, excerpts; 400/500/600, italic) and Figtree (UI;
400/500/600), both self-hosted by `next/font`. CJK fallbacks: Songti SC / Noto Serif CJK SC for
serif, PingFang SC / Noto Sans CJK SC for sans. Base UI size 14px; article body 19.5px/1.55
(CJK 18px/1.8).

Motion: `animate-fade` (250 ms fade + 4px rise) on view changes and popovers.

## Layout rules

- Header 56px, sticky: logo (serif 26px/600), Reading/Discover pills, search field (md+),
  locale switcher, avatar (accent circle with initial) and sign-out.
- Reading view (`/reading`) is a three-column grid on `lg+`: sidebar 220px, list
  `minmax(280px, 380px)` or 260px when an article is open, main `minmax(0, 1fr)`. Sidebar and
  list are sticky and scroll independently. Below `lg` the sidebar is hidden and the list gives way
  to the reader when an article is open (mobile pass in phase 8).
- List rows: feed swatch (10px), feed name, relative time, `XX → EN` badge for foreign posts,
  accent unread dot, serif title (19px wide / 15.5px slim), two-line excerpt, `min · ♡ · ↗` row.
  Read rows render at 62% opacity; the open row has a white background.
- Reader: `✕ Close` left, Like (and Recommend, phase 7) right; meta line with swatch, feed,
  author, time, reading time, original link; serif title 40px/1.12; body max 640px; author card
  with a 44px round swatch, site title, tagline, reader count, and the visibility note.
- Swatch colors are derived from the feed id (`oklch(0.55 0.11 hue)`, hue = id × 137.508 mod 360)
  so a feed keeps its color everywhere without storing one.

## Components (`apps/web/src/components`)

`AppHeader`, `LocaleSwitcher`, `ReadInMenu`, `Sidebar`, `ArticleList`, `Reader`,
`TranslationBar`, `LikeButton`, `MarkRead`, `RequestTranslation`, `AutoRefresh`, `EmptyState`,
`Swatch`, `SiteAvatar`, `SiteCard`, `RecommendPopover`. Discover's hero, topic chips, language
menu (a native `<details>` dropdown), and claim banner live in `app/discover/page.tsx`.

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
