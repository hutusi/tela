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
})
