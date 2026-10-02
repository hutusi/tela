import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { en } from '../src/content/info/en'
import { INFO_PAGES, INFO_SECTIONS, type Section } from '../src/content/info/types'
import { zhHans } from '../src/content/info/zh-Hans'
import { Inline, parseInline, plainText, safeHref } from '../src/lib/inline-links'

const html = (text: string) =>
  renderToStaticMarkup(
    createElement(StaticRouter, { location: '/' }, createElement(Inline, { text })),
  )

describe('inline links in the info pages', () => {
  test('split text into runs and links', () => {
    expect(
      parseInline('See [Privacy](/privacy#public), or [GitHub](https://github.com/x).'),
    ).toEqual([
      { text: 'See ' },
      { text: 'Privacy', href: '/privacy#public' },
      { text: ', or ' },
      { text: 'GitHub', href: 'https://github.com/x' },
      { text: '.' },
    ])
    expect(parseInline('no links here')).toEqual([{ text: 'no links here' }])
    expect(plainText('Read [the terms](/terms) first')).toBe('Read the terms first')
  })

  test('allow https, a path on this site and an anchor, and nothing else', () => {
    for (const href of ['https://hutusi.com/about', '/privacy', '/privacy#cookies', '#contact'])
      expect(safeHref(href)).toBe(href)
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      'http://example.com',
      'mailto:someone@example.com',
      '//evil.example',
      '/\\evil.example',
      'https://user:pass@evil.example',
      'ftp://example.com',
    ])
      expect(safeHref(href)).toBeNull()
  })

  test('a refused link is its text alone, and never markup', () => {
    expect(parseInline('a [click](javascript:alert%281%29) b')).toEqual([{ text: 'a click b' }])
    const out = html('[x](javascript:alert%281%29) [y](data:text/html,hi) <b>z</b>')
    expect(out).not.toContain('href')
    expect(out).not.toContain('<b>')
    expect(out).toContain('&lt;b&gt;')
  })

  test('render a path in the app, another site and an anchor as links', () => {
    const out = html('[Terms](/terms) · [GitHub](https://github.com/hutusi/tela) · [up](#who)')
    expect(out).toContain('href="/terms"')
    expect(out).toContain('href="https://github.com/hutusi/tela" rel="noopener noreferrer"')
    expect(out).toContain('href="#who"')
  })

  test('every link the copy carries, in both languages, is one the renderer keeps', () => {
    for (const content of [en, zhHans])
      for (const page of INFO_PAGES) {
        const sections = content[page].sections as Record<string, Section>
        expect(Object.keys(sections).sort()).toEqual([...INFO_SECTIONS[page]].sort())
        const texts = [
          ...content[page].short,
          ...Object.values(sections).flatMap((s) =>
            s.blocks.flatMap((b) =>
              'p' in b
                ? [b.p]
                : 'list' in b
                  ? [...b.list]
                  : 'entries' in b
                    ? b.entries.flatMap((e) => [e.name, e.text])
                    : [],
            ),
          ),
        ]
        for (const text of texts)
          for (const match of text.matchAll(/\]\(([^)]*)\)/g)) {
            const href = match[1] ?? ''
            expect(safeHref(href)).toBe(href)
            if (href.startsWith('#'))
              expect(INFO_SECTIONS[page] as readonly string[]).toContain(href.slice(1))
          }
      }
  })
})
