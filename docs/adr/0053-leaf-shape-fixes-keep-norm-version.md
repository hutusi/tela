# 0053 — Paragraphs survive normalization, and a leaf-shape fix keeps NORM_VERSION

Status: accepted (2026-10-23). Amends 0005: changing which elements become leaves no longer bumps
`NORM_VERSION`. Changing what a tagged text means, or how it is hashed, still does.

## Context

A member reported that some translations read as one paragraph. Paul Graham's "How to Work Hard"
(article 4981) was a single block holding a single leaf of 17,975 characters:

- Readability kept his layout as `<tr><td><img><span>June 2021<p>…</p>…<blockquote>…</span></td></tr>`,
  with no `<table>` around it.
- A leaf was a leaf tag with no block *child*. The `<td>`'s children are an `<img>` and a `<span>`,
  so the whole cell was one leaf, and the one row was the article's only block.
- Tagged text drops any tag it does not know and keeps its text, so the model was sent
  `<g1>June 2021It might not seem…</g1>`, and translated it as one run.
- The original looked right, because it shows the source HTML, `<p>`s and all.
- The model also copied the essay's hard line breaks into the Chinese, and Chrome draws each one as
  a space between two characters.

Running the old and new rules over the raw HTML of 151 random production bodies found four shapes
that lose paragraphs:

- **an inline element around blocks:** every Paul Graham essay (`<span>` around the `<p>`s),
  Blogger's `<span><span><p>`, and `<a>` around a card;
- **table parts outside a table:** Paul Graham's essays, whose one row was each essay's only block;
- **inline-only wrappers beside other words:** `<div>One.</div><div>Two.</div>` was one leaf
  reading "One.Two.", on both sides. It also glued a book card's "Amazon" link to the next card's
  picture;
- **`<br><br>` between paragraphs:** whole Blogger and Hatena posts, up to 7,748 characters, in one
  leaf. The original renders fine. The translation keeps the breaks only if the model leaves every
  `<xN/>` where it was, and validation checks the multiset of placeholders, not their positions.

ADR 0005 and invariant 10 said every normalization rule change bumps `NORM_VERSION`. A bump would
change every block hash, so the whole translation cache would miss. `translate.body` would also
refuse every stored body (6,346 of them) as predating the version, until a replay that
re-normalizes them from their raw HTML had been built.

## Decision

**The rules.** `annotateBlocks` (`packages/content/README.md` §2 is the spec):

1. Table parts (`tbody thead tfoot tr td th caption`) outside a `<table>` are unwrapped, as a
   browser's parser ignores them.
2. Where an unwrapped wrapper's words would run into words outside it, a boundary keeps them apart,
   so they become separate paragraphs. Only text, or an element holding text or an image, counts as
   words: an empty permalink beside a heading's title does not. No boundary goes inside a `<pre>`.
3. An inline element that holds blocks is a wrapper:
   - a bare `<span>` is unwrapped;
   - anything else (an `<a>`, a `<b>`, a `<span lang>`) is pushed down, a copy of it around each
     inline run and each leaf's content, so a card's link reaches its title and its text.
4. In a `<p>`, two or more `<br>`s in a row end the paragraph when there are words before and after
   them. A single `<br>` stays: it is a line break in a poem or an address. So do breaks at the
   start or the end, which separate nothing.

The model is sent each block with its whitespace collapsed (`translateBlocks`). HTML shows a run of
whitespace as one space, so nothing visible changes, and the cache key already collapses it.

**The bump is for what a tagged text means.** The cache maps a tagged text to its translation.
`NORM_VERSION` exists so that one tagged text never means two things, and changes to these still
bump it:

- the placeholder grammar;
- the tagged-text serialization;
- the hash input.

Which elements become leaves is not part of that contract. A leaf that changes shape has a
different tagged text, and so a different hash. A cache entry made from the old shape is still the
right translation of the old text.

So a fix to leaf shapes keeps `NORM_VERSION`, provided it leaves every tree without the shape
byte-identical. The evidence is the fixture snapshots and the stored bodies, and the commit names
both. Here, two of the three snapshot fixtures are unchanged, content hash included. The third
(`jnito`) changed only by the book card that rule 2 separates. Of the 962 items in the 21 fixture
feeds, 33 changed. Of the 151 production bodies, 21 changed, and each one read by hand was one of the
four shapes.

**Stored bodies are re-versioned by the paths that already exist**, not by a replay:

- an extracted post is made due for extraction again;
- a feed is made to process every item it still lists (`docs/OPERATIONS.md`).

A new content key is a new version. Old body translations stay with the old content keys.

## Consequences

- Paul Graham's essay is 73 blocks, the longest 914 characters. It pairs paragraph by paragraph,
  and its translation streams in chunks instead of arriving in one call.
- After the deploy, a feed's items get new versions as the feed is next processed in full, if their
  bodies had one of the shapes (about one in seven in the sample). Each new version means:
  - a new content object;
  - a seq bump, so devices fetch the body again;
  - a fresh title translation, if the new body's excerpt differs.
- A body translated before it was re-versioned is translated again when a member next opens it.
- An excerpt with unescaped markup in its text can now split mid-sentence, where a browser breaks
  the line too: one azukiazusa summary whose prose names `<div role="search">`.
- Translations already cached keep the line breaks the model copied. Only blocks sent from now on
  are collapsed.

## Alternatives considered

- **Bump to 2 and build the replay.** It re-pays every cached block to fix one body in seven, and
  blocks translation until the replay has run over every body.
- **Only lift the inline wrapper.** Paul Graham stays one block, because of the orphaned row: the
  translation keeps its paragraphs, but one grid row still holds the whole essay, and nothing
  streams.
