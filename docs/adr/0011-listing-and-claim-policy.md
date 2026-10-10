# 0011 — Listing and claim policy: any feed is subscribable, Discover shows claimed sites

Status: accepted (2026-09-04). Listing rule superseded by ADR 0018; the claim mechanics stand,
with two more proofs beside them (ADR 0045).

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
  (support action); a later verifier's claim fails instead of taking the site over.
- A site is keyed by the home the feed declares, not by the feed's host: a blog whose feed lives
  on FeedBurner or a CDN is still verified (and shown) at its own origin. The first fetch moves
  the feed there, joining an existing unclaimed site, splitting off from a placeholder other
  feeds share, or leaving a claimed site alone. A declared home never attaches a feed to a site
  another member claimed, whether at creation or on fetch; the claimant can. The claim flow keys
  the site by the page the member entered, since that is where the proof must appear.
- A claimed site only carries feeds it vouches for: served from its own origin, declared by its
  home page (`rel="alternate"` links recorded at verification, together with the URLs they
  redirect to, since a hosted feed is stored under its final URL), or added by the claimant. A feed
  is judged by the origin that actually served it, so a URL on the site that redirects elsewhere
  cannot put another host's posts under the site, and feeds that attached to an unclaimed
  placeholder are moved off the moment the owner proves control.
- Verification runs from the worker, so mainland-China sites go through the relay once it exists.
