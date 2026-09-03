# 0010 — next-intl without i18n routing

Status: accepted (2026-09-04)

## Context

The UI ships in Simplified Chinese and English. Locale-prefixed URLs (`/en/...`, `/zh/...`) require
middleware, which on OpenNext depends on `proxy.ts` support that only landed on 2026-08-26. The
reading language (what articles are translated into) is a separate preference from the UI locale.

## Decision

- next-intl in "without i18n routing" mode: the locale comes from the `tela_locale` cookie, then the
  profile setting, then `Accept-Language`. No `[locale]` route segment, no middleware.
- Message catalogs in `apps/web/messages/{en,zh-Hans}.json`; every key exists in both.
- `profiles.reading_lang` is independent of `ui_locale` and defaults to it.

## Consequences

- No per-locale URLs for SEO on public pages yet; can be added later with `?hl=` or a prefix once
  the adapter's middleware support has matured.
- One fewer moving part on Cloudflare; the app also runs unchanged elsewhere.
