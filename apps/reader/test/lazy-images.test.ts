import { describe, expect, test } from 'bun:test'
import { lazyImages } from '../src/lib/lazy-images'

const LAZY = '<img loading="lazy" decoding="async"'

describe("an article's images", () => {
  test('load lazily and decode off the main thread, every one of them', () => {
    expect(lazyImages('<p>One <img src="/img/k/0" alt="a"></p><p><img src="/img/k/1"></p>')).toBe(
      `<p>One ${LAZY} src="/img/k/0" alt="a"></p><p>${LAZY} src="/img/k/1"></p>`,
    )
    expect(lazyImages('<img><img/>')).toBe(`${LAZY}>${LAZY}/>`)
  })

  test('a body without one comes back as it was', () => {
    const html = '<p>No pictures, <em>none</em>.</p>'
    expect(lazyImages(html)).toBe(html)
    // Not an image: text that says so, and tags that only start the same.
    expect(lazyImages('<p>&lt;img src=x&gt;</p><imgx></imgx>')).toBe(
      '<p>&lt;img src=x&gt;</p><imgx></imgx>',
    )
  })

  test('"<img" inside an attribute is text: its quotes are never broken open', () => {
    // As the stored HTML serializes a hostile alt (dom-serializer leaves `<` and `>` raw in an
    // attribute). Rewriting the inner "<img" would close the alt and make `onerror` an attribute.
    const html = '<p><img src="/img/k/0" alt="<img onerror=alert(1) x=&quot;> y"> z</p>'
    expect(lazyImages(html)).toBe(
      `<p>${LAZY} src="/img/k/0" alt="<img onerror=alert(1) x=&quot;> y"> z</p>`,
    )
    expect(lazyImages('<a title="<img src=x>">t</a>')).toBe('<a title="<img src=x>">t</a>')
  })
})
