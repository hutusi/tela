# 0051 — Response headers: a day of asset caching

Status: accepted (2026-10-19).

## Context

tela-web's static assets answer without running the Worker (ADR 0020), with the asset router's
default `Cache-Control: public, max-age=0, must-revalidate`. Every script, stylesheet and font a
page loads is content-hashed, yet a browser without the shell's service worker (a first visit, a
browser that blocks workers, a public page opened from a link) asks again for each one on every
visit and waits for the 304.

The obvious header for content-hashed files is `max-age=31536000, immutable`. It is wrong here.
`run_worker_first` is a list, so the asset router's single-page fallback answers every request it
has no file for, a missing `/assets/*` name included, 200 with `index.html` (AGENTS.md). Headers
from `_headers` are applied by path, so that HTML carries the `/assets/*` rule too. After a
rollback, or in the minutes when a cached shell names files the new deploy removed, a browser can
be handed the app's HTML under a script's name; with a year and `immutable` it would keep that
answer for a year, and boot blank whenever it asked the HTTP cache for that script. The service
worker already refuses to keep such an answer (`fits` in `sw.js`), but it fetched through the
browser's cache, so it would have been refused the same answer for as long as the browser kept
it.

## Decision

- **`/assets/*` is `public, max-age=86400`** (`apps/reader/public/_headers`): a day, and not
  `immutable`. A browser keeps a hashed file a day without asking; a wrong answer it was handed
  lasts a day at most.
- **The shell's service worker asks past the browser's cache once** (`fetchAsset` in `sw.js`):
  when a hashed file's answer is not what its name says, it fetches it again with
  `cache: 'reload'`, which goes to the network and replaces what the browser held. A shell swap
  therefore never waits out the day, and a page asking for the file through the worker gets the
  real one as soon as the network has it. `SHELL` is not bumped: no released worker cached
  anything wrong.

## Consequences

- Repeat visits without the worker skip a revalidation per file for a day.
- A rollback can leave a browser with no worker holding the app's HTML under a script's name for
  up to a day. Such a browser boots blank on that build until the day runs out, or until a
  hard reload. `max-age` is the knob: shorten it before a risky rollback if that is a concern.
- `_headers` is the only place that sets asset headers, and a rule added there lands on the
  fallback's `index.html` for every path it matches (AGENTS.md). A long cache on a pattern that
  can name a missing file keeps HTML under that name.
