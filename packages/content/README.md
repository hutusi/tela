# @tela/content

The pure content pipeline: no I/O, no database, runs on Node, Bun, and Cloudflare Workers.
This file is the normative spec for how article bodies become **blocks**. The block hashes are a
contract with the translation cache: whenever what a tagged text means or how it is hashed changes
(§3, §4), bump `NORM_VERSION` in `@tela/shared` so old and new cache entries never mix. A fix to
which elements become leaves (§2) keeps it, provided every tree without the fixed shape annotates
byte-identically (ADR 0053). Any change to what `processArticleHtml` makes of a body (sanitizing,
normalization, skips, excerpts; a `NORM_VERSION` bump too) bumps `PIPELINE_VERSION`, and
`article.reprocess` makes every stored body again from its raw HTML (ADR 0055).

## Pipeline

```
feed text ─parseFeedText─▶ ParsedFeed { items: { contentHtml | summaryHtml, url, guid, … } }
item html ─sanitizeArticleHtml─▶ allowlisted HTML, absolute URLs
          ─annotateBlocks─────▶ leaf blocks with data-tb ids, tagged text, block summaries
          ─detectLanguage / makeExcerpt / readingMinutes
          = processArticleHtml(...) → ProcessedContent
```

Subpath exports keep the web bundle small: `@tela/content/images` (signed proxy URLs, image
rewriting) and `@tela/content/tagged` (placeholder grammar) have no parser dependencies;
`@tela/content/extract` (Readability + linkedom) is worker-only.

## 1. Sanitization (`sanitize.ts`)

- Allowlist only. Block tags: `p h1-h6 ul ol li blockquote pre figure figcaption table thead tbody
  tfoot tr th td caption dl dt dd details summary hr` plus wrappers `div section article aside
  header footer main` (unwrapped in step 2). Inline tags: `a em strong b i u s del ins mark sub sup
  span abbr cite q small kbd samp var code br img time dfn bdi bdo wbr`.
- Removed with content: `script style textarea option noscript template svg iframe video audio
  object embed form button input select canvas math head title` (an `iframe`, `video` or `audio`
  worth a link has become one by then, below). Any other tag is dropped but its
  text is kept. `font→span`, `center→div`, `strike→s`, `tt→code`, `picture→span`.
- Attributes: `a[href title hreflang]`, `img[src alt title width height]`, table `colspan rowspan
  scope`, `ol[start reversed type]`, `li[value]`, `code/pre[class=language-*|lang-*]`, `abbr/dfn[title]`,
  `q/blockquote[cite]`, `details[open]`, `time[datetime]`, and `dir`/`lang` everywhere.
- Embeds become links first (`embedsAsLinks`, ADR 0054): a `video` or `audio` (its `src` or first
  `source`), and an `iframe` that is a player or a card (a known player or card host, or an address
  with an `/embed`, `/player`, `/video`… segment), is replaced by `<div><a href>` to where it can
  be opened: a YouTube or Vimeo player's watch page, a link card's `url` parameter. The link
  reads `▶ host/path` for what plays and `↗ host/path` for the rest. Any other iframe is a widget
  and goes with its content; so does an embed whose following `<cite>` already links its address
  (Hatena's blog cards). The link is its own block, so the paragraph around a player keeps its
  text and its hash.
- URLs are absolutized against the article URL (fallback: feed URL). `href` that is not http(s) or
  mailto turns the link into a `span`. `img` without a usable http(s) `src` is dropped, as are 1×1
  pixels. Lazy-loading attributes (`data-src`, `data-original`, `data-lazy-src`, `data-actualsrc`)
  are used when `src` is missing or a `data:` URI. `srcset` is dropped.

## 2. Normalization (`blocks.ts`)

Goal: every text-bearing element is a **leaf** whose children are inline only.

0. A highlighter's line-number table (one row, a `pre` of digits beside a `pre` of code, as Hexo
   and Hugo lay code out) is replaced by its code `pre`.
1. Unwrap `div section article aside header footer main`, and `tbody thead tfoot tr td th caption`
   outside a `<table>` (a browser's parser ignores those): replace each with its children,
   bottom-up. Where the wrapper's words would run into words outside it, keep a boundary between
   them, so `<div>One.</div><div>Two.</div>` is two leaves, not one reading "One.Two.". Words are
   text, or an element holding text or an `img`: an empty permalink beside a heading's title is
   not. No boundary goes inside a `<pre>`.
2. An inline element that holds blocks is a wrapper. A bare `<span>` is unwrapped. Any other
   element (an `<a>` around a card, a `<span lang>`) is pushed down: a copy of it wraps each inline
   run, and each leaf's content, inside it.
3. In the root, in `blockquote figure details`, and in any element that has block children, wrap
   each run of inline nodes in `<p>`. In `ul`/`ol`, stray runs are wrapped in `<li>`. Whitespace-only
   text between blocks is dropped.
4. A `<p>` that ended up with block children is a wrapper: unwrap it.
5. In a `<p>`, two or more `<br>`s in a row (whitespace between them allowed) end the paragraph
   when there are words before and after them; the `<br>`s go. A single `<br>` stays, and so do
   breaks before the first words or after the last.
6. Remove empty leaves (`<p></p>`, `<p> </p>`, `<p><br></p>`); keep leaves that contain an `img`,
   and keep every table cell however empty, since a cell removed slides the rest of its row under
   the wrong heading.

Leaf tags: `p h1-h6 li figcaption th td dt dd summary caption pre`. A `li` (or `td`, …) that still
contains blocks is a container, and its wrapped `<p>` children are the leaves. Whether a leaf holds
blocks is read from its direct children: step 2 makes sure no inline element hides them.

## 3. Tagged text (`tagged.ts`)

The translator never sees HTML. A leaf's inline content becomes tagged text:

| Source | Placeholder | Stored aside |
|---|---|---|
| `a em strong b i u s del ins mark sub sup span abbr cite q small dfn bdi bdo time` | paired `<gN>…</gN>`, children translated | tag + attributes |
| `br img code kbd samp var wbr` | opaque `<xN/>` | tag + attributes + inner HTML |
| any other inline element | tag dropped, text kept | — |

`N` counts up per kind in document order within the block. Text outside placeholders is
HTML-escaped (`&lt; &gt; &amp;`). Example:

```
<p>Click <a href="/x">here</a> for <code>foo</code>.<br></p>
→ Click <g1>here</g1> for <x1/>.<x2/>
```

Rehydration (`fromTaggedText`) decodes and re-escapes every text segment, so markup emitted by a
model renders literally; unknown or unbalanced placeholders are dropped. `checkPlaceholders`
accepts a translation only when it carries exactly the source's placeholder multiset, properly
nested; reordering is allowed.

## 4. Hashes and ids (`hash.ts`)

```
hash = sha256( NFC(collapse_whitespace(trim(tagged_text))) + " v" + NORM_VERSION )
id   = first 10 hex of hash, with "-2", "-3", … for repeated blocks in the same article
```

The id is written as `data-tb` on the leaf; `data-tb-skip` marks blocks that are not translated.
`translations` rows are keyed by the full hash and the target language. The model is sent each
block with its whitespace collapsed (`translateBlocks` in `@tela/llm`), as the hash is: a line
break in the source is where an editor wrapped, and copied into Chinese it shows as a space.

Skipped blocks: `pre`; blocks whose plain text is shorter than two characters; blocks with no
letters (`\p{L}`), which covers image-only paragraphs, dates, and separators; and blocks that are
only an address (a bare URL, a link showing one, an embed's `▶`/`↗` link), which a model can only
echo, and an echo is refused as untranslated.

## 5. Derived fields

- `detectLanguage`: soft hyphens, zero-width marks and links are removed first. Then script ratios
  (kana ≥ 5% → `ja`, hangul ≥ 20% → `ko`, han ≥ 30% → `zh-Hans`/`zh-Hant` by simplified-vs-traditional
  character counts), then eld's extra-small model (60 languages). The hint (the item's declared
  language, else the blog's majority, else the feed's declared language) decides text of fewer than
  20 letters, and wins only when it scores within 90% of the best guess: declared tags are sometimes
  a template's default. Detection is not part of any hash.
- `makeExcerpt`: first three translatable blocks, ≤ 280 chars, cut on a word boundary for
  non-CJK text, ellipsis appended.
- `readingMinutes`: CJK characters / 400 + words / 230, minimum 1.
- `contentHash`: sha256 of the annotated HTML; a change bumps `articles.content_version`.

## 6. Feeds (`feed.ts`, `discover.ts`, `dedup.ts`)

- `parseFeedText` normalizes RSS, Atom, RDF, and JSON Feed (via feedsmith) into `ParsedFeed`.
  `summaryHtml` is the short form (description / summary), `contentHtml` the full form
  (`content:encoded`, Atom content, `content_html`). Relative URLs resolve against the home URL.
- `findFeedLinks` lists declared `<link rel=alternate>` feeds, then feed-looking anchors;
  `candidateFeedUrls` gives the well-known paths to probe.
- `dedupKey`: `g:<guid>` → `u:<normalized link>` → `h:<sha256(title|published_at)>`.

## 7. Content objects (`object.ts`, ADR 0022)

What a reader receives, built once at ingest and stored immutably at `c/<key>.json`:

- `key` is the first 32 hex of `contentHash`, the SHA-256 of the annotated HTML with its
  *original* image URLs. The key never depends on how images are served.
- `blocks` are the top-level children (the pairing unit of ADR 0019). Each holds its HTML and
  the leaf `data-tb` ids inside it, in document order. Every leaf appears in exactly one block.
- `leaves` maps each leaf id to `{hash, chars, skip?}`: the full block hash the translation
  cache is keyed by, and the length that budgets use.
- `images` lists the original URLs. Each `<img src>` in `blocks` is rewritten to
  `/img/<key>/<index>`, one index per distinct URL, and gains `data-origin`. The proxy resolves
  an index against the object, so it can only fetch URLs that stored content contains.
- `format` is `OBJECT_FORMAT` and `norm` is the `NORM_VERSION` the leaves were annotated under.

Image `src` is an attribute, and attributes never enter tagged text (§3). So rewriting images
changes no block hash, and the object format is not a `NORM_VERSION` matter. Changing *what* the
object contains is: bump `OBJECT_FORMAT` and keep readers able to render the previous format
until every live article has a new version.

## Fixtures

`fixtures/feeds/` holds real captures listed in `fixtures/SOURCE.md` and
`src/fixtures.test-helper.ts`. `process.test.ts` snapshots block ids and hashes for three of them.
A failing snapshot means either the contract changed and `NORM_VERSION` needs a bump, or a leaf
shape was fixed (ADR 0053); the commit says which.
