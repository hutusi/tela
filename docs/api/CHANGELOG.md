# API changelog

Changes to Tela's API for apps, newest first. See [policy.md](policy.md) for how changes are made
and announced.

## v1 preview — 2026-10-27

The first version, for approved apps.

- **Connecting:** OAuth 2.1 for native apps, with PKCE (S256), a loopback or private-use scheme
  redirect, the consent page at `https://telaread.com/connect`, hour-long access tokens and
  refresh tokens swapped on every use, and revocation. Scopes `read`, `write` and `email`.
- **`/meta`**, `/v1/me` and `/v1/usage`.
- **Sync** (`/v1/sync`) with an opaque cursor, translation rows and titles in one reading language
  at a time, and fourteen row types; **mutations** (`/v1/mutations`), seventeen types, one answer
  each.
- **Bodies, translations and images:** `/v1/bodies`, the immutable objects at `/o/…`, and the
  image proxy at `/img/…`, with the daily limit on posts from blogs the member does not follow.
- **Translations:** asking (`POST /v1/translations`) and their status.
- **Adding feeds:** discovery, adding by address, and OPML import.
- **The public side:** Discover's five tabs, blog pages, profiles, blogrolls, search, and opening a
  public post with `/v1/articles/{id}`.
