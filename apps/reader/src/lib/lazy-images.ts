/**
 * An article's images as they render: fetched as they near the screen, and decoded off the main
 * thread, not all at once the moment the post opens. A long post's images are most of what
 * opening it costs, and most are never scrolled to.
 *
 * Done to the HTML at render time, not to the stored object: the attributes are no part of what
 * @tela/content sanitizes, normalizes or hashes (an image is a placeholder to a block's hash), so
 * no `NORM_VERSION` bump, no cache entry changes, and every stored body gets them at once.
 *
 * The first image is lazy too. HTML set through `innerHTML` is invisible to the preload scanner,
 * so even an eager image starts no sooner than the render that inserts it; a lazy one inside the
 * viewport starts at that render's layout, a frame later at most.
 */

/**
 * A tag, with its double-quoted attribute values whole. The stored HTML escapes `<` and `>` in
 * text but not inside an attribute (dom-serializer's `encodeEntities: 'utf8'`), so `<img` inside
 * an `alt="…"` is text, and must not be taken for a tag: inserting quotes into a value would close
 * it early and turn the rest of the value into attributes (`onerror=…`).
 */
const TAG = /<(?:[^>"]|"[^"]*")*>/g
const IMG = /^<img(?=[\s/>])/

export function lazyImages(html: string): string {
  if (!html.includes('<img')) return html
  return html.replace(TAG, (tag) =>
    IMG.test(tag) ? `<img loading="lazy" decoding="async"${tag.slice(4)}` : tag,
  )
}
