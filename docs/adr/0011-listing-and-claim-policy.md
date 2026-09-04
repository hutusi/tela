# 0011 — Listing and claim policy: any feed is subscribable, Discover shows claimed sites

Status: accepted (2026-09-04)

## Context

Tela's identity is "every feed here has a human behind it", but readers must be free to follow
any feed. The two goals conflict only for the public directory. Bloggers need a low-friction way
to prove ownership that works on every platform, including static hosts and platforms without
DNS access.

## Decision

- **Any feed can be subscribed privately.** Adding a feed creates its site as `private`; private
  sites never appear in Discover but work everywhere else.
- **Discover lists `listed` and `featured` sites.** A site becomes `listed` the moment a claim is
  verified; `featured` is a manual flag (SQL for now, an admin page later). `rejected` hides a
  site regardless of claims.
- **Claiming** is per user and site (`site_claims`). The user gets a token and proves control by
  either a `<meta name="tela-site-verification" content="…">` tag or a `rel="me"` link to their
  Tela profile on the site's home page. The `claim` worker role fetches the home page and marks
  the claim verified or failed with a readable reason; the page polls while pending. DNS TXT is
  a later option.
- **Claimants curate**: topics on the site page (from the fixed list in `@tela/shared`), later
  translation opt-out and the author dashboard.
- **Reader counts** are distinct users subscribed to any feed of the site, recomputed on
  subscribe/unsubscribe.

## Consequences

- The directory stays human-backed by construction: nothing is listed without a person who
  proved control of the domain.
- A site claimed by one member cannot be claimed by another until the first claim is removed
  (support action).
- Verification runs from the worker, so mainland-China sites go through the relay once it exists.
