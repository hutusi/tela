# 0051 — Response headers: a day of asset caching, and security headers

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
browser's cache, so it would have been handed the same answer for as long as the browser kept
it.

Nor did any page carry a security header: no Content-Security-Policy, HSTS, `nosniff`,
Referrer-Policy or anything that stops another site framing Tela. The shell is served by the asset
router, which the Worker never sees, and the public pages by the Worker, so neither alone could
add them.

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
- **One set of security headers, given two ways** (`SECURITY_HEADERS` in
  `apps/reader/worker/security.ts`): `public/_headers` gives it to everything the asset router
  serves (`/*`, the shell at any path), and the edge sets it on every HTML answer it builds (a
  rendered page, from the colo's cache too, the plain shell when tela-api fails, a member's `/`).
  `apps/reader/test/security.test.ts` holds `_headers` to the constant.
- **Enforced from the start:** `Strict-Transport-Security: max-age=31536000` (no
  `includeSubDomains` until every subdomain is known to serve HTTPS), `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a
  `Permissions-Policy` that turns off the camera, microphone, geolocation, payment, USB and the
  Topics API.
- **The CSP is report-only for a week first:** `default-src 'self'`, scripts from `'self'` and the
  theme script by its hash (never `'unsafe-inline'` for scripts), styles from `'self'` and
  `'unsafe-inline'` (the views set `style` attributes the edge renders and the app mounts over
  without hydrating), images from `'self'`, `https://assets.telaread.com` and `blob:` (the
  picture crop), fonts, fetches, the manifest and the worker from `'self'`, no plugins, no
  `<base>`, forms to `'self'` and no framing. `upgrade-insecure-requests` joins when the policy is
  enforced: report-only, browsers ignore it and warn about it in the console on every page. The test recomputes the theme script's hash from `index.html`,
  so a change to that script cannot ship without the policy. The app reports each
  `securitypolicyviolation` it sees to `/api/client-errors`; once a week of real use reports
  none, the header becomes `Content-Security-Policy` (a follow-up, not this change).

## Consequences

- Repeat visits without the worker skip a revalidation per file for a day.
- A new inline script, an image host or a third-party fetch needs the policy changed in
  `security.ts` and `_headers` together; until the CSP is enforced it only shows as reports.
- The HSTS year is cached by every browser that visits: going back to plain HTTP on
  `telaread.com` is not possible for a year after.
- A rollback can leave a browser with no worker holding the app's HTML under a script's name for
  up to a day. Such a browser boots blank on that build until the day runs out, or until a
  hard reload. `max-age` is the knob: shorten it before a risky rollback if that is a concern.
- `_headers` is the only place that sets asset headers, and a rule added there lands on the
  fallback's `index.html` for every path it matches (AGENTS.md). A long cache on a pattern that
  can name a missing file keeps HTML under that name.
