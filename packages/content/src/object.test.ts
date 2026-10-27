import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NORM_VERSION } from '@tela/shared'
import { parseFeedText } from './feed'
import { FIXTURE_FEEDS, FIXTURES_DIR } from './fixtures.test-helper'
import {
  buildContentObject,
  contentKeyOf,
  imageProxyPath,
  OBJECT_FORMAT,
  objectKeys,
} from './object'
import { processArticleHtml } from './process'

const body = (html: string) => processArticleHtml({ html, baseUrl: 'https://blog.example/post/' })

/**
 * Every content object's shape, by `OBJECT_FORMAT`: its keys, its blocks', its leaves' (optional
 * ones marked `?`) and its stats'. Apps read objects as they are stored (`/o/c/…`, ADR 0065), and
 * `format` is how they know what they read. A change to the shape is a new format: add its entry
 * here and bump `OBJECT_FORMAT`; never edit an entry a format already shipped with.
 */
const SHAPES: Record<number, Record<string, string[]>> = {
  1: {
    object: ['blocks', 'format', 'images', 'key', 'lang', 'leaves', 'norm', 'stats'],
    block: ['html', 'leaves', 'tag'],
    leaf: ['chars', 'hash', 'skip?'],
    stats: ['chars', 'minutes', 'words'],
  },
}

describe('a content object’s shape', () => {
  test('is the one its OBJECT_FORMAT says, so apps can trust `format`', async () => {
    // A leaf with words and one without (`skip`), and an image.
    const object = buildContentObject(
      await body('<p>Words to read <img src="https://cdn.example/a.png"></p><p>2026</p>'),
    )
    expect(object.format).toBe(OBJECT_FORMAT)
    const leaves = Object.values(object.leaves)
    expect(leaves.some((l) => l.skip)).toBe(true)
    const keys = (value: object) => Object.keys(value).sort()
    const always = leaves.map(keys).reduce((a, b) => a.filter((k) => b.includes(k)))
    const shape = {
      object: keys(object),
      block: [...new Set(object.blocks.flatMap(keys))].sort(),
      leaf: [...new Set(leaves.flatMap(keys))]
        .map((k) => (always.includes(k) ? k : `${k}?`))
        .sort(),
      stats: keys(object.stats),
    }
    if (JSON.stringify(shape) !== JSON.stringify(SHAPES[OBJECT_FORMAT])) {
      throw new Error(
        `a content object's shape changed without OBJECT_FORMAT (${OBJECT_FORMAT}): bump it and add its shape to SHAPES`,
      )
    }
    expect(shape).toEqual(SHAPES[OBJECT_FORMAT] as typeof shape)
  })
})

describe('buildContentObject', () => {
  test('is keyed by the annotated body, and the same body always builds the same object', async () => {
    const a = buildContentObject(await body('<p>Hello <a href="/x">there</a>.</p>'))
    const b = buildContentObject(await body('<p>Hello <a href="/x">there</a>.</p>'))
    expect(a).toEqual(b)
    expect(a.key).toHaveLength(32)
    expect(a.norm).toBe(NORM_VERSION)
    expect(objectKeys.content(a.key)).toBe(`c/${a.key}.json`)
  })

  test('points images at the proxy by index, once per distinct URL', async () => {
    const processed = await body(
      '<p>One <img src="https://cdn.example/a.png" alt="a"></p>' +
        '<figure><img src="/b.jpg"><figcaption>Cap</figcaption></figure>' +
        '<p>Again <img src="https://cdn.example/a.png"></p>',
    )
    const object = buildContentObject(processed)
    expect(object.images).toEqual(['https://cdn.example/a.png', 'https://blog.example/b.jpg'])
    const html = object.blocks.map((b) => b.html).join('')
    expect(html).not.toContain('cdn.example/a.png"')
    expect(html.match(new RegExp(imageProxyPath(object.key, 0), 'g'))).toHaveLength(2)
    expect(html).toContain(`src="${imageProxyPath(object.key, 1)}"`)
    expect(html).toContain('data-origin="cdn.example"')
  })

  test('the key hashes original image URLs, so a proxy change never renames content', async () => {
    const processed = await body('<p>Pic <img src="https://cdn.example/a.png"></p>')
    expect(buildContentObject(processed).key).toBe(contentKeyOf(processed))
    expect(processed.html).toContain('https://cdn.example/a.png')
  })

  test('keeps a list or table as one block and every leaf in exactly one block', async () => {
    const object = buildContentObject(
      await body('<p>Intro</p><ul><li>One</li><li>Two</li></ul><table><tr><td>A</td></tr></table>'),
    )
    expect(object.blocks.map((b) => b.tag)).toEqual(['p', 'ul', 'table'])
    const ids = object.blocks.flatMap((b) => b.leaves)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual(Object.keys(object.leaves).sort())
  })

  test('holds for every captured feed: each leaf once, images all proxied', async () => {
    let articles = 0
    for (const [file, base] of Object.entries(FIXTURE_FEEDS)) {
      const feed = parseFeedText(readFileSync(join(FIXTURES_DIR, file), 'utf8'), base)
      for (const item of feed.items.slice(0, 5)) {
        const html = item.contentHtml ?? item.summaryHtml
        if (!html) continue
        const object = buildContentObject(
          await processArticleHtml({ html, baseUrl: item.url ?? base }),
        )
        const ids = object.blocks.flatMap((b) => b.leaves)
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids.length).toBe(Object.keys(object.leaves).length)
        const joined = object.blocks.map((b) => b.html).join('')
        expect(joined).not.toMatch(/<img[^>]+src="https?:/)
        articles++
      }
    }
    expect(articles).toBeGreaterThan(60)
  })
})
