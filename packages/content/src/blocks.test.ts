import { describe, expect, test } from 'bun:test'
import { annotateBlocks, rehydrateBlocks, taggedTextsOf } from './blocks'

describe('annotateBlocks', () => {
  test('wraps loose inline runs and unwraps wrappers', async () => {
    const { html, blocks } = await annotateBlocks(
      'Intro text <em>here</em>.<div><p>Para</p>tail text</div><section><h2>Head</h2></section>',
    )
    expect(html).toMatch(/^<p data-tb="[0-9a-f]{10}">Intro text <em>here<\/em>\.<\/p>/)
    expect(html).toContain('<p data-tb="')
    expect(html).not.toContain('<div')
    expect(html).not.toContain('<section')
    expect(blocks.map((b) => b.tag)).toEqual(['p', 'p', 'p', 'h2'])
    expect(blocks.map((b) => b.chars)).toEqual([16, 4, 9, 4])
  })

  test('list items with nested lists become containers', async () => {
    const { html, blocks } = await annotateBlocks(
      '<ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>',
    )
    expect(blocks.map((b) => b.tag)).toEqual(['p', 'li', 'li'])
    expect(html).toMatch(
      /<li><p data-tb="[0-9a-f]{10}">One<\/p><ul><li data-tb="[0-9a-f]{10}">Nested<\/li><\/ul><\/li>/,
    )
  })

  test('removes empty blocks and keeps image-only blocks as skipped', async () => {
    const { html, blocks } = await annotateBlocks(
      '<p></p><p> </p><p><br></p><p><img src="https://x/y.png"></p><p>T</p>',
    )
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.skip).toBe(true)
    expect(blocks[0]?.tag).toBe('p')
    expect(html).toContain('data-tb-skip')
    expect(blocks[1]?.skip).toBe(true) // "T" is shorter than two characters
  })

  test('pre blocks are skipped and duplicates get suffixes', async () => {
    const { blocks, tagged } = await annotateBlocks(
      '<p>Same text</p><pre><code>let x = 1</code></pre><p>Same text</p><p>Other text</p>',
    )
    expect(blocks[0]?.id).toHaveLength(10)
    expect(blocks[2]?.id).toBe(`${blocks[0]?.id}-2`)
    expect(blocks[0]?.hash).toBe(blocks[2]?.hash as string)
    expect(blocks[1]?.skip).toBe(true)
    expect(blocks[1]?.tag).toBe('pre')
    expect(Object.keys(tagged)).toEqual([0, 2, 3].map((i) => blocks[i]?.id as string))
  })

  test('numeric-only blocks are skipped', async () => {
    const { blocks } = await annotateBlocks('<p>2024</p><p>— · —</p><p>Real words</p>')
    expect(blocks.map((b) => Boolean(b.skip))).toEqual([true, true, false])
  })

  test('rehydrates translated tagged text with the original placeholders', async () => {
    const source =
      '<p>Click <a href="https://e.x/">here</a> for <code>foo</code>.</p><pre>keep</pre>'
    const { html, blocks, tagged } = await annotateBlocks(source)
    const id = blocks[0]?.id as string
    expect(tagged[id]).toBe('Click <g1>here</g1> for <x1/>.')
    expect(taggedTextsOf(html)).toEqual({ [id]: 'Click <g1>here</g1> for <x1/>.' })

    const out = rehydrateBlocks(html, { [id]: '点击<g1>这里</g1>查看 <x1/>。<b>x</b>' })
    expect(out).toContain(
      `<p data-tb="${id}">点击<a href="https://e.x/">这里</a>查看 <code>foo</code>。&lt;b&gt;x&lt;/b&gt;</p>`,
    )
    expect(out).toContain('<pre data-tb=')
    expect(out).toContain('>keep</pre>')
  })

  test('is stable: annotating annotated html yields the same ids', async () => {
    const first = await annotateBlocks(
      '<p>Alpha <strong>beta</strong></p><blockquote>quote text</blockquote>',
    )
    const second = await annotateBlocks(first.html)
    expect(second.blocks.map((b) => b.id)).toEqual(first.blocks.map((b) => b.id))
    expect(second.html).toBe(first.html)
  })
})
