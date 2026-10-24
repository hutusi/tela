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

  test('table parts outside a table are unwrapped, and stay inside one', async () => {
    // Readability's output for paulgraham.com: a row and a cell, and no table.
    const { html, blocks } = await annotateBlocks(
      '<tr><td><img src="https://x/t.gif"><span>June 2021<p>First paragraph.</p><p>Second one.</p></span></td></tr>',
    )
    expect(html).not.toMatch(/<t[rd]/)
    expect(blocks.map((b) => b.tag)).toEqual(['p', 'p', 'p'])
    expect(html).toMatch(/^<p data-tb="[0-9a-f]{10}"><img src="https:\/\/x\/t.gif">June 2021<\/p>/)

    const table = await annotateBlocks('<table><tr><td>Cell one</td><td>Cell two</td></tr></table>')
    expect(table.blocks.map((b) => b.tag)).toEqual(['td', 'td'])
  })

  test('an inline element around paragraphs gives each paragraph its own leaf', async () => {
    const { blocks, tagged } = await annotateBlocks(
      '<td><span>Intro<p>One para.</p><blockquote>A quote.</blockquote><p>Two para.</p></span></td>',
    )
    expect(blocks.map((b) => b.tag)).toEqual(['p', 'p', 'p', 'p'])
    expect(Object.values(tagged)).toEqual(['Intro', 'One para.', 'A quote.', 'Two para.'])

    // Blogger nests the paragraphs a few spans deep inside a <p>.
    const blogger = await annotateBlocks(
      '<p><br><span><span><p><span>First words.</span></p><p>More words.</p></span></span></p>',
    )
    expect(Object.values(blogger.tagged)).toEqual(['<g1>First words.</g1>', 'More words.'])
  })

  test('a link around blocks is pushed down into each of them', async () => {
    const { html, tagged } = await annotateBlocks(
      '<a href="https://e.x/post"><div><h3>Card title</h3><p>Card text</p></div></a>',
    )
    expect(html).toMatch(
      /<h3 data-tb="[0-9a-f]{10}"><a href="https:\/\/e.x\/post">Card title<\/a><\/h3>/,
    )
    expect(html).toMatch(
      /<p data-tb="[0-9a-f]{10}"><a href="https:\/\/e.x\/post">Card text<\/a><\/p>/,
    )
    expect(Object.values(tagged)).toEqual(['<g1>Card title</g1>', '<g1>Card text</g1>'])
  })

  test('wrappers whose words would run into their neighbours stay separate paragraphs', async () => {
    const siblings = await annotateBlocks(
      '<div>Para one.</div><div>Para two.</div>tail <b>text</b>',
    )
    expect(Object.values(siblings.tagged)).toEqual(['Para one.', 'Para two.', 'tail <g1>text</g1>'])

    // A wrapper alone in its parent is unwrapped as before: no paragraph appears inside the item.
    const lone = await annotateBlocks('<ul><li><div>Only child</div></li></ul>')
    expect(lone.html).toMatch(/^<ul><li data-tb="[0-9a-f]{10}">Only child<\/li><\/ul>$/)
    // An empty permalink beside a centred title shows nothing to run into: the heading stays one.
    const heading = await annotateBlocks(
      '<h2><a href="https://e.x/#t" title="t"></a><div>Title</div></h2><p>Body text</p>',
    )
    expect(heading.blocks.map((b) => b.tag)).toEqual(['h2', 'p'])
    // Nor inside a <pre>, where the text is literal.
    const pre = await annotateBlocks('<pre>one<div>two</div></pre>')
    expect(pre.blocks.map((b) => [b.tag, b.skip])).toEqual([['pre', true]])
  })

  test('two line breaks end a paragraph, one does not', async () => {
    const { blocks, tagged } = await annotateBlocks(
      '<p>Jeff: First.<br><br>Leo: Second,<br>\nstill second.<br>\n<br>\n<br>Jeff: Third.</p>',
    )
    expect(blocks.map((b) => b.tag)).toEqual(['p', 'p', 'p'])
    expect(Object.values(tagged)).toEqual([
      'Jeff: First.',
      'Leo: Second,<x1/>\nstill second.',
      'Jeff: Third.',
    ])

    // Breaks before the first words or after the last separate nothing and stay.
    const edges = await annotateBlocks('<p><br><br>Only words.<br><br></p>')
    expect(Object.values(edges.tagged)).toEqual(['<x1/><x2/>Only words.<x3/><x4/>'])
  })

  test('an empty table cell stays, so the rest of its row keeps its columns', async () => {
    const { html, blocks } = await annotateBlocks(
      '<table><tr><th></th><th>Before</th><th>After</th></tr><tr><td>Speed</td><td></td><td>Fast</td></tr></table>',
    )
    expect(html.match(/<t[hd][ >]/g)).toHaveLength(6)
    expect(blocks.filter((b) => b.skip).map((b) => b.tag)).toEqual(['th', 'td'])
  })

  test("a highlighter's line-number table is stored as its code", async () => {
    const code = '<pre><span>let a = 1</span><br><span>a += 1</span></pre>'
    for (const shape of [
      `<figure><table><tbody><tr><td><pre><span>1</span><br><span>2</span></pre></td><td>${code}</td></tr></tbody></table></figure>`,
      // onevcat.com: Readability leaves it inside a <code>.
      `<code><table><tr><td><pre>1\n2\n</pre></td><td>${code}</td></tr></table></code>`,
    ]) {
      const { html, blocks } = await annotateBlocks(shape)
      expect(html).not.toContain('<table')
      expect(html).toContain('<span>let a = 1</span>')
      expect(blocks.map((b) => [b.tag, b.skip])).toEqual([['pre', true]])
    }
    // A table of numbers and words is a table.
    const real = await annotateBlocks('<table><tr><td>1</td><td>Alpha</td></tr></table>')
    expect(real.html).toContain('<table')
  })

  test('a block that is only an address is not translated', async () => {
    const { blocks } = await annotateBlocks(
      '<p>https://example.com/post</p><p><a href="https://x.org/a">x.org/a</a></p>' +
        '<p><a href="https://www.youtube.com/watch?v=1">▶ youtube.com/watch?v=1</a></p>' +
        '<p>Read more at <a href="https://x.org">x.org</a> today.</p>',
    )
    expect(blocks.map((b) => Boolean(b.skip))).toEqual([true, true, true, false])
  })

  test('paragraph boundaries survive translation', async () => {
    const { html, blocks } = await annotateBlocks(
      '<tr><td><span><p>Hello there.</p><p>Goodbye now.</p></span></td></tr>',
    )
    const [first, second] = blocks.map((b) => b.id) as [string, string]
    const out = rehydrateBlocks(html, { [first]: '你好。', [second]: '再见。' })
    expect(out).toBe(`<p data-tb="${first}">你好。</p><p data-tb="${second}">再见。</p>`)
  })

  test('is stable: annotating annotated html yields the same ids', async () => {
    const first = await annotateBlocks(
      '<p>Alpha <strong>beta</strong></p><blockquote>quote text</blockquote>' +
        '<a href="https://e.x/"><div><p>card</p></div></a><div>one</div><div>two<br><br>three</div>',
    )
    const second = await annotateBlocks(first.html)
    expect(second.blocks.map((b) => b.id)).toEqual(first.blocks.map((b) => b.id))
    expect(second.html).toBe(first.html)
  })
})
