# 0019 — Block-paired bilingual reading

Status: accepted (2026-09-19). Works within ADR 0016's render budget and ADR 0017's URL rule;
amends neither.

## Context

`AGENTS.md` describes Tela as showing a post "beside its original block by block". The reader did
not do that. Side-by-side rendered two whole HTML documents into two grid cells with
`items-start`, so paragraph 7 of the translation sat wherever its column's preceding paragraphs
happened to end — nowhere near paragraph 7 of the original, and further away with every paragraph.

Two consequences had gone unnoticed because nothing measured them.

The two columns switched on at `xl`, a **1280px viewport**. The reader pane is the third cell of a
`220px 260px minmax(0,1fr)` grid, so at that viewport it is 800px wide: less `px-8` and a 40px gap,
**348px per column** — about 32 characters of 19.5px Garamond, 19 of CJK at 18px. Each column's
`max-w-[640px]` did not bind until roughly a 1920px viewport. The Playwright desktop project runs
at exactly 1280, and the one translation test asserted that both bodies were *visible*, which is
equally true when they are stacked.

Below `xl` they did stack — as two whole documents. A reader finished the post in Chinese and found
it again in English underneath. That is not a bilingual reading mode.

## Decision

- **Pair on the document's top-level children, not on `data-tb`.** `LEAF_TAGS` includes `li`, `td`,
  `th`, `dt` and `dd`, which are stamped inside `ul`/`table`/`dl`; zipping at leaf granularity
  would lift an `<li>` out of its list. A top-level child is the smallest unit that can stand
  alone in a grid cell. `packages/content/src/split.ts` does the split; pairing them by index is
  sound because `rehydrateBlocks` builds the translated body from the same annotated HTML and only
  replaces leaf children.
- **Split on the server, in `buildReaderData`.** A direct `/reading?article=…` is still a server
  render, and `DOMParser` does not exist on Workers, so a browser-side split would either mismatch
  on hydration or re-lay-out after mount. Shipping `htmlparser2` to the browser would also add tens
  of kilobytes to the bundle of a pane whose whole justification is being cheap (ADR 0017).
  Signing and splitting share one parse, so this costs no more CPU than the render it replaced.
- **One grid, one row per block, cells in `o1, t1, o2, t2 …` order.** Two columns place pair *i* on
  row *i*, so the sides align by construction and no scroll-sync code is needed. One column reads
  the same DOM as an interleave, at the full 640px measure. Per-side wrappers were rejected for
  exactly this reason: `display: contents` and `grid-template-rows: subgrid` both preserve the two
  columns but put every translation before every original when they collapse.
- **The original leads, in both.** Left-hand column where there are two, above the translation
  where they stack. That is the arrangement of every facing-page edition, and because one DOM
  order produces both, it is also the only choice where nothing changes places as the window
  crosses the two-column threshold. Translation-first was built first, on the reasoning that the
  translation is what the reader reads and the eye lands left; seeing it rendered settled it the
  other way.
- **A container query on the pane, not a viewport breakpoint.** Two columns appear at a 1080px
  container — 520px each — because the pane is not the viewport and never was. In practice that is
  about a 1624px viewport, so the interleave is what most readers see. It is the better read of
  the two: full measure, and the original is one block away instead of one column away.
- **When the two sides disagree, do not pair at all.** Differing lengths, ids or tags fall back to
  a single row holding both whole bodies. A mis-zip would put paragraph 12 beside paragraph 11 for
  the rest of the article, which is worse than the layout this replaced.
- **The original sits on its own ground** (`--color-source`, derived from `--color-hover` and
  `--color-paper`), continuous down the second column and a panel per block when stacked. The
  dimming this replaces never worked: `.article-body` colours the block itself, so a `text-ink-2`
  utility on a wrapper only ever reached the `<h1>`.

## Consequences

- `ReaderData.html` and `ReaderTranslation.html` are gone; both bodies cross the wire as
  `ReaderBlock[]`. Single-language modes join them back, so nothing is sent twice.
- `body-translated` and `body-original` name one cell each in single-language modes and N cells
  in side-by-side. Tests assert equal counts above one, which is the only assertion that
  distinguishes real pairing from two documents in two cells.
- Each block is its own `.article-body`, and grid items do not collapse margins with siblings, so
  `.article-block > *` zeroes the top margin and the row restores a heading's lead. Vertical
  rhythm is now something a stylesheet decides rather than something margin collapsing did.
- `styles.e2e.ts` measures the columns at 1280, 1440 and 1700. Nothing did before, which is why
  348px columns shipped.
