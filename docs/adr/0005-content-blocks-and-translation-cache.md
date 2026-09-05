# 0005 — Sanitized HTML with tagged-text blocks and a content-addressed translation cache

Status: accepted (2026-09-04)

## Context

Article bodies arrive as arbitrary HTML from thousands of generators. Tela needs a canonical
form that is safe to render, stable across refetches, and translatable paragraph by paragraph so
the original and the translation can be shown side by side. Translating raw HTML with a model is
unreliable (tags get mangled) and unsafe (the model can emit markup). Hashing plain text alone
makes paragraphs that differ only by a link target collide.

## Decision

- Canonical body = allowlist-sanitized HTML (`sanitize-html`), normalized so every text-bearing
  element is a leaf block (`packages/content/README.md` is the normative spec).
- Each leaf's inline content is converted to **tagged text**: XLIFF-style placeholders
  (`<g1>…</g1>` paired, `<x1/>` opaque) with attributes and opaque content kept in a side table
  derived from the source block. The model sees only text and placeholders.
- Block id = first 10 hex of `sha256(normalized tagged text + NORM_VERSION)`, written as
  `data-tb`. `translations(source_hash, target_lang, source_lang)` caches translated tagged text per block,
  across articles and versions.
- Rehydration decodes and re-escapes text segments, so model output can never inject markup;
  translations are accepted only if their placeholder multiset matches the source.
- Body images are not stored; original URLs are rewritten at render time to a signed proxy.

## Consequences

- Retranslation after an edit costs only the changed blocks; recurring footers cost once.
- Two sentences with different link targets share one cache entry, which is correct: the target
  comes from the source block at render time.
- Rule changes require a `NORM_VERSION` bump (snapshot tests enforce it) and invalidate the cache.
- Alternatives considered: storing structured JSON blocks (loses fidelity for tables, footnotes,
  embeds); translating whole HTML (unsafe, unstable); hashing plain text (link collisions).
