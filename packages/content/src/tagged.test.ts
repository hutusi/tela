import { describe, expect, test } from 'bun:test'
import {
  checkPlaceholders,
  fromTaggedText,
  type InlineNode,
  plainText,
  toTaggedText,
} from './tagged'

const text = (data: string): InlineNode => ({ type: 'text', data })
const tag = (
  name: string,
  attribs: Record<string, string>,
  children: InlineNode[] = [],
): InlineNode => ({
  type: 'tag',
  name,
  attribs,
  children,
})

describe('tagged text', () => {
  const nodes: InlineNode[] = [
    text('Click '),
    tag('a', { href: 'https://example.com/x' }, [text('here')]),
    text(' for '),
    tag('code', {}, [text('foo<bar>')]),
    text('.'),
    tag('br', {}),
  ]

  test('converts inline markup to placeholders', () => {
    const { text: tagged, placeholders } = toTaggedText(nodes)
    expect(tagged).toBe('Click <g1>here</g1> for <x1/>.<x2/>')
    expect(placeholders.g1).toEqual({ tag: 'a', attrs: { href: 'https://example.com/x' } })
    expect(placeholders.x1).toEqual({ tag: 'code', attrs: {}, html: 'foo&lt;bar&gt;' })
    expect(placeholders.x2).toEqual({ tag: 'br', attrs: {} })
  })

  test('round-trips back to HTML', () => {
    const { text: tagged, placeholders } = toTaggedText(nodes)
    expect(fromTaggedText(tagged, placeholders)).toBe(
      'Click <a href="https://example.com/x">here</a> for <code>foo&lt;bar&gt;</code>.<br>',
    )
  })

  test('nested placeholders keep their order and attributes', () => {
    const { text: tagged, placeholders } = toTaggedText([
      tag('em', {}, [text('a '), tag('strong', {}, [text('b')]), text(' c')]),
    ])
    expect(tagged).toBe('<g1>a <g2>b</g2> c</g1>')
    expect(fromTaggedText('<g1>x <g2>y</g2></g1>', placeholders)).toBe(
      '<em>x <strong>y</strong></em>',
    )
  })

  test('escapes markup the model might emit and keeps entities stable', () => {
    const placeholders = { g1: { tag: 'em', attrs: {} } }
    expect(fromTaggedText('Hello <b>bold</b> <g1>x</g1>', placeholders)).toBe(
      'Hello &lt;b&gt;bold&lt;/b&gt; <em>x</em>',
    )
    expect(fromTaggedText('a &lt; b &amp; c', {})).toBe('a &lt; b &amp; c')
    expect(fromTaggedText('<g9>unknown</g9> <x7/>', placeholders)).toBe('unknown ')
  })

  test('drops unbalanced closers and closes what stays open', () => {
    const placeholders = { g1: { tag: 'em', attrs: {} }, g2: { tag: 'strong', attrs: {} } }
    expect(fromTaggedText('<g1>a</g2>b', placeholders)).toBe('<em>ab</em>')
  })

  test('plainText strips placeholders and decodes entities', () => {
    expect(plainText('Click <g1>here</g1> &amp; <x1/> now')).toBe('Click here & now')
  })

  test('checkPlaceholders accepts reordering but not loss or bad nesting', () => {
    const src = 'A <g1>b</g1> <g2>c</g2> <x1/>'
    expect(checkPlaceholders(src, '<g2>c</g2> <x1/> a <g1>b</g1>').ok).toBe(true)
    expect(checkPlaceholders(src, 'A <g1>b</g1> c <x1/>').ok).toBe(false)
    expect(checkPlaceholders(src, 'A <g1>b <g2>c</g1></g2> <x1/>').ok).toBe(false)
    expect(checkPlaceholders(src, 'A <g1>b</g1> <g2>c</g2> <x1/><x1/>').ok).toBe(false)
  })
})
