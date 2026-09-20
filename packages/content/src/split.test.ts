import { describe, expect, test } from 'bun:test'
import { annotateBlocks } from './blocks'
import { renderArticleBlocks } from './split'

describe('renderArticleBlocks', () => {
  test('one entry per top-level child, in order', async () => {
    const blocks = await renderArticleBlocks('<p>One</p><h2>Head</h2><p>Two</p>', null)
    expect(blocks.map((b) => b.tag)).toEqual(['p', 'h2', 'p'])
    expect(blocks.map((b) => b.html)).toEqual(['<p>One</p>', '<h2>Head</h2>', '<p>Two</p>'])
  })

  test('a list stays one block: an <li> is a leaf but never a top-level child', async () => {
    const { html } = await annotateBlocks('<p>Intro</p><ul><li>One</li><li>Two</li></ul>')
    const blocks = await renderArticleBlocks(html, null)
    expect(blocks.map((b) => b.tag)).toEqual(['p', 'ul'])
    expect(blocks[1]?.html).toContain('<li data-tb=')
    expect(blocks[1]?.ids).toHaveLength(2)
  })

  test('a table stays one block and collects every id inside it', async () => {
    const { html } = await annotateBlocks('<table><tr><td>A</td><td>B</td></tr></table>')
    const blocks = await renderArticleBlocks(html, null)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.tag).toBe('table')
    expect(blocks[0]?.ids).toHaveLength(2)
  })

  test('joining the blocks reproduces the body, every id exactly once', async () => {
    const { html } = await annotateBlocks(
      '<p>One</p><ul><li>A</li><li>B</li></ul><blockquote><p>Q</p></blockquote><hr>',
    )
    const blocks = await renderArticleBlocks(html, null)
    expect(blocks.map((b) => b.html).join('')).toBe(html)
    const ids = blocks.flatMap((b) => b.ids)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe([...html.matchAll(/data-tb="/g)].length)
  })

  test('a block with no ids keeps an empty list rather than going missing', async () => {
    const blocks = await renderArticleBlocks('<hr><p>After</p>', null)
    expect(blocks.map((b) => b.tag)).toEqual(['hr', 'p'])
    expect(blocks[0]?.ids).toEqual([])
  })

  test('keeps a bare text run between blocks and drops whitespace', async () => {
    const blocks = await renderArticleBlocks('<p>One</p>\n  loose\n  <p>Two</p>\n', null)
    expect(blocks.map((b) => b.tag)).toEqual(['p', '#text', 'p'])
  })

  test('empty html is no blocks', async () => {
    expect(await renderArticleBlocks('', null)).toEqual([])
  })

  test('signs image sources in the same pass', async () => {
    const blocks = await renderArticleBlocks(
      '<p>One</p><p><img src="https://example.com/a.png"></p>',
      async (url) => `/img?u=${encodeURIComponent(url)}`,
    )
    expect(blocks[1]?.html).toContain('src="/img?u=https%3A%2F%2Fexample.com%2Fa.png"')
    expect(blocks[1]?.html).toContain('data-origin="example.com"')
  })
})
