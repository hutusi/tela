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

  // Indie blogs surround a post with things readability scores as text. Each shape below is one
  // it took for the post on maggieappleton.com, where many posts are mostly illustrations.
  const illustrated = (
    after: string,
    inside = '',
  ) => `<!doctype html><html><head><title>Databases</title></head><body>
    <main>
      <article class="prose-wrapper">
        <h1>A Starter Guide to Databases</h1>
        <p>Illustrated notes on how databases keep things, drawn over a weekend.${inside}</p>
        <img src="/one.png" alt=""><img src="/two.png" alt=""><img src="/three.png" alt="">
      </article>
      ${after}
    </main>
  </body></html>`
  const long = (words: string) => `${words} `.repeat(12)

  test('a post of illustrations is not its webmentions, even under a class that says content', () => {
    const html = illustrated(`<div class="outer-container"><div class="mentions-scroll-container">
      <div class="mentions-content-container"><div class="reply"><div class="content">
        <p>${long('A reader replied with a long and warm note about this drawing and databases.')}</p>
      </div></div></div></div></div>`)
    expect(extractArticle(html, 'https://blog.example/databases')?.contentHtml ?? '').not.toContain(
      'A reader replied',
    )
  })

  test('a link preview in a template is not text', () => {
    const preview = `<span class="tooltip-trigger"><a href="/babel">Babel</a><template class="tooltip-content"><p>${long('Another post about compilers, shown only on hover.')}</p></template></span>`
    const html = illustrated('', ` It follows on from ${preview}.`)
    const out = extractArticle(html, 'https://blog.example/databases')?.contentHtml ?? ''
    expect(out).not.toContain('shown only on hover')
  })

  test('a menu of cards is not a post', () => {
    const cards = ['Essays', 'Notes', 'Patterns', 'Talks', 'Podcasts', 'Library']
      .map(
        (k) =>
          `<li><a href="/${k}"><h3>${k}</h3><p>${long(`Everything filed under ${k} on this site`)}</p></a></li>`,
      )
      .join('')
    const html = illustrated('').replace(
      '<main>',
      `<div class="panel"><ul>${cards}</ul></div><main>`,
    )
    expect(extractArticle(html, 'https://blog.example/databases')).toBeNull()
  })

  test('an @mention inside a post is part of the post', () => {
    const paragraph =
      'This is a long enough paragraph of article text that Readability will keep. '.repeat(6)
    const html = `<html><body><article><h1>Thanks</h1><p>${paragraph}</p>
      <p>Drawn with help from <a class="u-url mention" href="https://social.example/@ada">@ada</a>. ${paragraph}</p>
    </article></body></html>`
    expect(extractArticle(html, 'https://blog.example/thanks')?.contentHtml).toContain('@ada')
  })

  test('a heading with a scroll-margin utility keeps its place, a comments title does not', () => {
    // aihero.dev: `scroll-mt-*` on every heading, and Readability's negative class pattern has
    // `scroll`, so every section heading went, words and all.
    const words = long('A paragraph of the post that says something worth reading about the loop.')
    const html = `<html><body><article>
      <p>${words}</p><h2 class="the-loop scroll-mt-[72px] tracking-[-0.025em]">The loop</h2>
      <p>${words}</p><h2 class="md:scroll-mt-24">How to update</h2><p>${words}</p>
      <h2 class="comments-title">3 comments</h2><p>${words}</p>
    </article></body></html>`
    const out = extractArticle(html, 'https://blog.example/loop')?.contentHtml ?? ''
    expect(out).toContain('The loop')
    expect(out).toContain('How to update')
    expect(out).not.toContain('3 comments')
  })

  test('a gallery of pictures stays in the post; a grid of related posts does not', () => {
    const words = long(
      'The walk went up through the cedars and down to the river by the old castle.',
    )
    const wordpress = [1, 2, 3, 4]
      .map(
        (n) =>
          `<dl class="gallery-item"><dt><a href="/p${n}.jpg"><img src="/p${n}.jpg"></a></dt><dd>Photo ${n}</dd></dl>`,
      )
      .join('')
    const figures = [5, 6, 7]
      .map(
        (n) => `<figure><a href="/p${n}.jpg"><img src="/p${n}.jpg" alt="Castle ${n}"></a></figure>`,
      )
      .join('')
    const related = [8, 9, 10]
      .map(
        (n) =>
          `<a href="/post-${n}"><img src="/r${n}.jpg"><span>Another post worth reading ${n}</span></a>`,
      )
      .join('')
    const html = `<html><body><article>
      <p>${words}</p><div class="gallery">${wordpress}</div>
      <p>${words}</p><div class="photogallery"><div class="photos">${figures}</div></div>
      <p>${words}</p><div class="grid">${related}</div>
    </article></body></html>`
    const out = extractArticle(html, 'https://blog.example/walk')?.contentHtml ?? ''
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(out).toContain(`/p${n}.jpg`)
    expect(out).not.toContain('Another post worth reading')
  })

  test('returns null for pages without an article', () => {
    expect(
      extractArticle('<html><body><a href="/">x</a></body></html>', 'https://x.example/'),
    ).toBeNull()
  })
})
