import { describe, expect, test } from 'bun:test'
import { extractArticle } from './extract'

describe('extractArticle', () => {
  test('pulls the main article out of a page', () => {
    const paragraph =
      'This is a long enough paragraph of article text that Readability will keep. '.repeat(6)
    const html = `<!doctype html><html><head><title>Post title</title></head><body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <article>
        <h1>Post title</h1>
        <p class="byline">By Ada</p>
        <p>${paragraph}</p>
        <p>Second paragraph with a <a href="/rel">relative link</a>. ${paragraph}</p>
      </article>
      <footer>© 2026 Example</footer>
    </body></html>`
    const out = extractArticle(html, 'https://blog.example/posts/1')
    expect(out).not.toBeNull()
    expect(out?.title).toBe('Post title')
    expect(out?.contentHtml).toContain('Second paragraph')
    expect(out?.contentHtml).not.toContain('About')
  })

  test('returns null for pages without an article', () => {
    expect(
      extractArticle('<html><body><a href="/">x</a></body></html>', 'https://x.example/'),
    ).toBeNull()
  })
})
