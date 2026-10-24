import { describe, expect, test } from 'bun:test'
import { sanitizeArticleHtml } from './sanitize'

const base = 'https://blog.example/posts/hello/'

describe('sanitizeArticleHtml', () => {
  test('removes dangerous elements with their content', () => {
    const html =
      '<p>ok</p><script>alert(1)</script><style>p{}</style><iframe src="x"></iframe><svg><text>svg</text></svg><noscript>n</noscript>'
    expect(sanitizeArticleHtml(html, base)).toBe('<p>ok</p>')
  })

  test('drops event handlers and unknown attributes', () => {
    expect(sanitizeArticleHtml('<p onclick="x()" id="a" style="color:red">t</p>', base)).toBe(
      '<p>t</p>',
    )
  })

  test('absolutizes links and images, and neutralizes bad schemes', () => {
    const html =
      '<a href="../other">rel</a> <a href="javascript:alert(1)">js</a> <a href="//cdn.example/x">pr</a> <img src="img.png" alt="i">'
    expect(sanitizeArticleHtml(html, base)).toBe(
      '<a href="https://blog.example/posts/other">rel</a> <span>js</span> <a href="https://cdn.example/x">pr</a> <img src="https://blog.example/posts/hello/img.png" alt="i" />',
    )
  })

  test('keeps mailto links', () => {
    expect(sanitizeArticleHtml('<a href="mailto:a@b.c">m</a>', base)).toBe(
      '<a href="mailto:a@b.c">m</a>',
    )
  })

  test('folds lazy-loading attributes into src and drops tracking pixels', () => {
    const html =
      '<img src="data:image/gif;base64,R0lGOD" data-src="/real.jpg"><img src="https://t.example/p.gif" width="1" height="1"><img alt="no src">'
    expect(sanitizeArticleHtml(html, base)).toBe('<img src="https://blog.example/real.jpg" />')
  })

  test('keeps only language classes on code blocks', () => {
    const html =
      '<pre class="language-ts highlight"><code class="language-ts">x</code></pre><p class="lead">t</p>'
    expect(sanitizeArticleHtml(html, base)).toBe(
      '<pre class="language-ts"><code class="language-ts">x</code></pre><p>t</p>',
    )
  })

  test('maps legacy tags and keeps text of unknown tags', () => {
    expect(
      sanitizeArticleHtml('<font color="red">a</font> <strike>b</strike> <custom>c</custom>', base),
    ).toBe('<span>a</span> <s>b</s> c')
  })

  test('keeps table structure attributes and dir/lang', () => {
    const html = '<table><tr><td colspan="2" dir="rtl" lang="ar">x</td></tr></table>'
    expect(sanitizeArticleHtml(html, base)).toBe(
      '<table><tr><td colspan="2" dir="rtl" lang="ar">x</td></tr></table>',
    )
  })

  test('a video or a player becomes a link to where it can be watched', () => {
    const cases: [string, string][] = [
      [
        '<iframe src="https://www.youtube-nocookie.com/embed/abc_123?rel=0"></iframe>',
        '<div><a href="https://www.youtube.com/watch?v=abc_123">▶ youtube.com/watch?v=abc_123</a></div>',
      ],
      [
        '<iframe src="https://player.vimeo.com/video/42"></iframe>',
        '<div><a href="https://vimeo.com/42">▶ vimeo.com/42</a></div>',
      ],
      [
        '<video controls><source src="/clip.mp4" type="video/mp4">Your browser cannot play it.</video>',
        '<div><a href="https://blog.example/clip.mp4">▶ blog.example/clip.mp4</a></div>',
      ],
      // A route map is opened, not played.
      [
        '<iframe src="https://www.komoot.com/tour/7/embed?hl=fr"></iframe>',
        '<div><a href="https://www.komoot.com/tour/7/embed?hl=fr">↗ komoot.com/tour/7/embed</a></div>',
      ],
      // A link card links to the post it shows.
      [
        '<iframe src="https://cdn.embedly.com/widgets/media.html?url=https%3A%2F%2Fx.example%2Fpost"></iframe>',
        '<div><a href="https://x.example/post">↗ x.example/post</a></div>',
      ],
    ]
    for (const [embed, link] of cases) expect(sanitizeArticleHtml(embed, base)).toBe(link)
  })

  test('a widget, a bad address, or a card its citation already links is not a link', () => {
    // slashdot puts a "discuss" box on every item; a like button is the same.
    expect(
      sanitizeArticleHtml(
        '<p>t</p><iframe src="https://slashdot.org/slashdot-it.pl?op=discuss&id=1&smallembed=1"></iframe>',
        base,
      ),
    ).toBe('<p>t</p>')
    expect(sanitizeArticleHtml('<video src="javascript:alert(1)"></video>', base)).toBe('')
    // Hatena writes a citation after each of its blog cards.
    const card =
      '<iframe src="https://hatenablog-parts.com/embed?url=https%3A%2F%2Fgithub.com%2Fa%2Fb"></iframe><cite><a href="https://github.com/a/b">github.com</a></cite>'
    expect(sanitizeArticleHtml(card, base)).toBe(
      '<cite><a href="https://github.com/a/b">github.com</a></cite>',
    )
  })
})
