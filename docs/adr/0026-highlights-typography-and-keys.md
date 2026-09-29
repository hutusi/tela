# 0026 — Highlights anchored to leaves, typography as synced prefs, and a small keyboard layer

Status: accepted (2026-09-29). Builds on 0022 (content versions), 0023 (translations aligned by
block) and 0025 (the member's rows sync to the device).

## Context

Reading features were in scope from the start of the refactor: highlights with notes, control
over text size, line length and theme, and a keyboard way through the list. Two facts shaped the
highlight design.

- **Posts change.** 5% of production articles were edited within three weeks, and a summary-only
  feed's post is replaced by its extracted text. A highlight stored as character offsets into a
  body would land on the wrong words after any edit before it.
- **The article DOM is sanitized HTML** rendered with `dangerouslySetInnerHTML`, and every
  top-level block pairs with its translation (0019). Wrapping highlighted text in `<mark>` would
  change the tree those rules rely on, and a re-render would lose it.

## Decision

**A highlight lives in one leaf.** A leaf is an element with a `data-tb` id (0005): a paragraph,
list item or cell. The anchor is the leaf id, offsets into the leaf's `textContent`, the quote, and
up to 32 characters of context either side. A selection that runs across leaves highlights its
part in the first one. Rows are the member's own and private, synced like likes (`putHighlight`,
`deleteHighlight`, ADR 0025).

- Ids are client-minted, so a replayed push cannot make two.
- Edits go to the later `at`, and delete wins: a stale edit from another device cannot bring a
  deleted highlight back.
- The server writes only the member's own live row, so an id copied from someone else's
  highlight rewrites nothing.
- A highlighted post is kept whatever the member subscribes to, like a liked one.

**Finding it again** (`apps/reader/src/lib/anchor.ts`), against the leaves the page renders:

1. The same leaf still holds the quote at the same offsets: exact.
2. Otherwise, every occurrence of the quote anywhere in the post is scored. The score is how much
   of the remembered context surrounds it, plus a bonus for its old leaf and for staying near its
   old place. The best wins.
3. Several candidates with barely any context (a matching space either side does not count) mean
   detached, not a guess. So does no occurrence at all.

The quote is always re-checked, even for an unchanged id, because a repeated block's id carries a
position suffix (`-2`, `-3`) that can name different text after an edit. A highlight that moved is
written back once with its new anchor and the current content key, so every device then finds it
directly.

**Either side of a translation.** A translation-side highlight keeps its target language and its
anchor into the translated leaf. It resolves only once the translation has finished; a streaming
one's text is still changing and would move or detach it for nothing. A side the layout does not
show is `elsewhere`, not detached.

**Painted, not wrapped.** Highlights are `Range`s registered with the CSS Custom Highlight API and
coloured by `::highlight(tela-highlight)`, so the article's DOM is never touched. A click on
painted text finds its highlight by hit-testing the caret position. A browser without the API
(before Chrome 105, Safari 17.2, Firefox 140) still lists the highlights under the article.

**Typography and theme are synced prefs** (`reader.size`, `reader.measure`, `ui.theme`). They are
named values rather than numbers, so a value a later build adds falls back to the default here.
Size and measure become `--reader-scale` and `--reader-measure` on the reader pane. Dark mode is
the same tokens on a warm near-black ground, under `data-theme` or, without one,
`prefers-color-scheme`. The lifted accent is `oklch(0.68 0.14 150)`, the tiled mark's green. The
chosen theme is cached in localStorage and applied by an inline script before anything paints.

**Keys on `/reading`:** `j`/`k` step through the list as shown, `Esc` closes the article and puts
focus back on its row, `h` highlights the selection, and `?` lists the keys. Typing in a field is
never a shortcut, and a popover that handles `Esc` itself keeps the article open.

## Consequences

- **An edit anywhere in a post leaves its highlights where they were**, and one that rewrites the
  passage says so rather than pointing at other words. The member keeps the quote and the note.
- **Nothing about highlights reaches the server but the member's own rows.** They are not shared,
  counted or shown to authors, unlike likes and recommendations.
- **Colours had to become tokens.** `bg-white` was on 31 elements, and every one stayed white on
  a dark ground until it became `bg-surface`. `styles.e2e.ts` checks the computed colours in both
  themes, and the text size and measure the reader gets.
- **The tests:**
  - the anchoring rules, on their own;
  - a highlight made, noted and reloaded in a browser;
  - the same highlight found again after the fixture post is edited, with its stored anchor
    rewritten to the new version;
  - detached once the passage is gone;
  - on the translation side, and shown as elsewhere in the original-only layout;
  - the keyboard layer, including `Esc` inside a popover.
