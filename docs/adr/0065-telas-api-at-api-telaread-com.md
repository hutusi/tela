# 0065 — Tela's API at api.telaread.com: shared rules, formats of its own

Status: accepted (2026-10-27). Amends 0042: `telaread.com` stays the only origin for people, and
`api.telaread.com` is the API's, for apps. Amends 0024's account of who serves what: tela-api still
has no public route, and a fifth Worker, `tela-gateway`, fronts the API. The authorization is 0064;
the daily limit on posts from unfollowed blogs is 0066.

## Context

Apps approved under 0064 need an API that works offline and syncs like the web app, that has its
own documented format and version, and that internal changes do not move. The web's protocol moves
often: `MIN_CLIENT` went from 1 to 4 in a month. Each bump makes cached shells reload, and a desktop
app cannot be made to reload. The internal routes also carry what the web needs and an app must not
have: `isAdmin`, claim tokens, privacy clocks, free-form prefs.

The owner's rule: **reuse logic, not routes.** Every rule lives in one shared function, every route
on the API host has its own documented format over those functions, and the web's routes stay free
to change. The one exception is the immutable content objects (bodies, translations, images), which
carry their own format.

## Decision

**The address is `https://api.telaread.com/v1/`.** It may become the public API, and the address is
hard to change once clients use it.

- A `telaread.com` subdomain is not affected by why 0042 kept one origin: `workers.dev` is what the
  mainland blocks. A boce.com check after launch confirms it.
- Host-only cookies never reach it, so the API is bearer-only by construction.
- None of the site's service worker, single-page fallback or `run_worker_first` applies there.

**`tela-gateway` (`apps/gateway`) serves it:** a thin edge Worker on the custom domain, with no
assets and no D1. Its bindings are R2, the colo cache, and the service binding to tela-api.

- It serves content objects and images itself (`@tela/edge`, shared with tela-web), so images load
  from near the reader.
- It forwards everything else to tela-api, which mounts the app surface at `/gateway/*`: outside
  `/api/`, so tela-web's forwarding never reaches it.
- It drops every cookie, refuses any credential that is not an access token, and answers
  `noindex`.

**Shared functions take an actor** (`{userId, exempt}`) and never read a request:

- translation admission and status;
- discovering, adding and importing feeds;
- usage;
- the pull and the push;
- the day's opened posts (0066);
- the public pages' queries.

The web passes `exempt` from `is_admin`, the API always `false`. The limits are therefore one set
for the web and every app, because every surface runs the same admission SQL.

**v1 is what a reading client needs, each route with its own minimal format** (`@tela/ext`, zod
schemas and an OpenAPI document generated from them):

| Group | Routes |
| --- | --- |
| Meta, me and usage | `GET /meta` (versions, features, limits; no token), `/v1/me` (no email without that permission), `/v1/usage` |
| Sync | `/v1/sync` and `/v1/mutations`, in the next section |
| Content | `/v1/bodies` (a bundle, with refusals), and the immutable objects as they are: `/o/c/…`, `/o/t/…`, `/o/tc/…`, `/img/…` |
| Translations | `/v1/translations`, asking and status |
| Feeds | `/v1/feeds/discover`, `/v1/feeds`, `/v1/feeds/opml` |
| The public side | `/v1/discover/…`, `/v1/sites/{id}`, `/v1/profiles/{handle}`, `/v1/blogrolls/{id}`, `/v1/search`, and `/v1/articles/{id}` to open a public post |

**Sync** is the web's model, written down for apps.

- A snapshot, then deltas.
- The cursor is opaque: seq, language, and the row types it covers. Changing the language or asking
  for a new type starts over.
- Translation rows come in the asked language only, so a change to the web's per-language storage
  (ADR 0052) never reaches apps.
- Prefs come from a documented allowlist.

**The push** is 17 mapped kinds, with one answer for each. A subscribe past the cap says so, rather
than being the web's silent no-op. Mutation ids are prefixed with the app's id, so apps cannot
cancel one another's.

**Never offered:** account, password, sign-in methods, sessions, deletion, export, invites, profile
and privacy edits, claims and writers' switches, reports, admin.

**A writer's "no translation" is enforced on the server for apps.** The web hides those
translations on the device, and an app cannot be trusted to. So:

- sync leaves out that site's titles and translations;
- asking answers `unavailable`;
- turning translation back on re-stamps that site's title and translation rows, so apps receive
  them.

**Versions:**

- The major version is in the path. Within a version, changes are additive only, and every enum is
  documented as open or closed.
- Golden fixtures pin every route's output (`docs/api/v1/examples/`, which are also the docs'
  examples). A shared function that moves one fails the suite, and the fix goes in the mapper.
- A breaking change is a new major version, announced at least three months before the old one is
  deprecated. The old one answers for twelve months after its successor ships, with `Deprecation`
  and `Sunset` headers for at least the last six.
- v1 is **preview** until the desktop app has run on it for four weeks without needing a break.
  While in preview, a break needs fourteen days' notice to the apps' developers.

## Alternatives considered

- **`telaread.com/ext/v1`.** One origin, but the API would share the site's cookie path, service
  worker and `run_worker_first`, and the address would be harder to give to a public API later.
- **Making `/api/v1` the shared API and moving the web's routes.** Every web change would become a
  versioned change, cached shells call the old paths, and "never admin" would rest on every route
  checking which credential it was given.
- **Serving the web's handlers from the API host.** It is less code, but each reused route would
  freeze the web to additive changes. The owner chose formats of the API's own.
- **A custom domain on tela-api.** It needs no new Worker, but every image would be fetched from
  Singapore, and tela-api would gain a public route.

## Consequences

- A fifth Worker to deploy (after tela-web) and to bundle in CI.
- Each new API route is a format and fixtures over an existing function, never a second copy of a
  rule.
- The device-code flow, app tokens, a sandbox, opening the API to everyone, and a Google Reader
  layer all fit this shape when they are built: another grant, another credential kind, the same
  fixtures served to a published token, a "not reviewed" state with CORS, and another adapter over
  the same functions.
