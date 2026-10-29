# API changelog

Changes to Tela's API for apps, newest first. See [policy.md](policy.md) for how changes are made
and announced.

## 2026-10-28 (later)

- **Discovery finds a listed blog's feeds from the blog's address.** When an address declares no
  feed, is not a feed, or cannot be reached, `POST /v1/feeds/discover` may answer with the live
  feeds of the blog at its origin that Tela lists in Discover, which can live on another host, in
  place of the error (`not_a_feed`, `unreachable`) it gave before. The format did not change.
- **A tenth topic, `ai`.** `topics` and the `topic` filter of `/v1/discover/articles` and
  `/v1/discover/blogs` may carry it. Topics were always an open set of strings.

## 2026-10-28

- **Any member registers apps,** in Settings → Developer: Testing for the developer alone, then
  Live for everyone. The operator reviews apps when their developers ask. An app not reviewed is
  shown as "Not reviewed by Tela", may hold at most 100 members at once across its developer's
  unreviewed apps, and can't ask for the email address. Members can report apps.
- **The consent page** shows an unreviewed app's developer by their Tela handle. No route or
  format of v1 changed.

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
