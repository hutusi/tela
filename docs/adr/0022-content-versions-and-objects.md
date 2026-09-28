# 0022 — Article bodies are immutable versions, stored as render-ready content objects

Status: accepted (2026-09-28). Supersedes 0007's signed image URLs (its proxy rules and the R2
favicon store stand). Amends 0005: the translation cache is unchanged, but it reads leaves from
content objects. Amends 0019: the split into top-level blocks happens at ingest, not per request.

## Context

Measured on production on 2026-09-27:

- **Bodies are not immutable.** 82 of 1,687 articles (5%) were edited within three weeks.
- **Many bodies are summaries.** 11 of 40 feeds are summary-only, so extraction replaces half
  the bodies Tela stores.
- **A bug came from treating the body as one mutable value.** The fetch path compared a feed
  item against the hash that extraction had overwritten (`fetch-feed.ts:403`). So the next change
  to the feed put the summary back, and `extract_checked_at` stopped extraction from ever running
  again.

On the read side, every article open repeated the same work:

- The Worker parsed the stored HTML, HMAC-signed every image and re-split it into top-level
  blocks. Translated articles paid for this twice.
- The output was identical for every reader and different only when the article changed. Yet it
  could not be cached, because it came out of a per-user query.

## Decision

- **A body is a sequence of versions** (`article_versions`). A version is never rewritten.
  - A changed feed item, a successful extraction and a renormalization each add one, tagged
    with its provenance: `feed` or `readability`.
  - `articles.current_version` and `content_key` say which version readers see. A pure function,
    `chooseCurrent`, decides that from the versions and the feed's content mode:
    - A feed item is compared only with the latest *feed* version.
    - On a summary-only feed, the latest readability version is current. A changed summary
      marks the article for re-extraction, and the old extraction stays current until the new
      one lands.
    - On a full-content feed, the feed version is current.
    - On a feed of unknown mode, the longer version wins, by at least 1.2×.
- **Each version's body is a content object** (`packages/content/src/object.ts`; format in the
  package README, §7):
  - It is stored once at `c/<key>.json`, keyed by the hash of the annotated HTML.
  - It is already split into top-level blocks carrying their leaf ids, and its images are
    already pointing at the proxy.
  - It holds nothing about one article, so identical bodies share one object.
  - The raw item HTML is kept at `r/<sha>.html`, so a `NORM_VERSION` bump can replay the whole
    pipeline.
- **Images go through `/img/<key>/<index>`.** The proxy reads `images[index]` from the object and
  keeps ADR 0007's rules: image types only, no SVG, a byte cap, a seven-day cache. It can fetch
  only URLs that stored content contains, which is what the HMAC signature guaranteed, without
  a secret to keep or rotate.
- **Objects are served to members only** (`/o/*`, with a session check against the signed
  cookie cache):
  - `Cache-Control: private, max-age=31536000, immutable` and `X-Robots-Tag: noindex`.
  - They are cached at the edge after the check.
  - Tela's copy of a blogger's post never becomes a public, indexable duplicate that competes
    with the blogger's own page.
- **Eager extraction.** A summary-only (or short, unknown-mode) article is marked
  `extract_state = 'due'` when it is stored, and the extraction sweep fetches its page under a
  per-host lease. Extraction costs no tokens, so waiting for the first reader to open the article
  bought nothing but a spinner.

## Consequences

- **Opening an article is a cache hit on an immutable file.** The Worker does no HTML work per
  request. The reader prefetches objects and keeps them on the device, since an object under a
  given key never changes.
- **Highlights keep the version they were made on.** Re-anchoring onto a newer version is a
  quote search against another immutable object (ADR 0026, to come).
- **The extraction regression cannot recur.** A feed item is never compared with a readability
  version, and a readability version is never overwritten by a feed version. A test pins both.
- **Storage grows with versions, not with rewrites.** At measured sizes (about 4 KB per body)
  this is cents per year on R2, and nothing is pruned (owner decision, 2026-09-27).
- **The object format is a contract.** Changing what an object contains means bumping
  `OBJECT_FORMAT`, and keeping readers able to render the previous format until every live
  article has a new version. Changing how blocks are *hashed* is still a `NORM_VERSION` bump
  (ADR 0005).
