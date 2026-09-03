import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFeedText } from './feed'
import { FIXTURE_FEEDS, FIXTURES_DIR } from './fixtures.test-helper'
import { processArticleHtml } from './process'

async function firstArticle(file: string) {
  const url = FIXTURE_FEEDS[file] as string
  const feed = parseFeedText(readFileSync(join(FIXTURES_DIR, file), 'utf8'), url)
  const item = feed.items[0]
  if (!item) throw new Error(`no items in ${file}`)
  const html = item.contentHtml ?? item.summaryHtml ?? ''
  return processArticleHtml({
    html,
    baseUrl: item.url ?? url,
    langHint: feed.language,
    title: item.title,
  })
}

describe('processArticleHtml on real articles', () => {
  const cases: Array<[string, string]> = [
    ['hutusi.rss.xml', 'zh-Hans'],
    ['jvns.atom.xml', 'en'],
    ['jnito.rss.xml', 'ja'],
  ]

  for (const [file, lang] of cases) {
    test(`${file}: language, blocks, and hashes are stable`, async () => {
      const out = await firstArticle(file)
      expect(out.lang).toBe(lang)
      expect(out.blocks.length).toBeGreaterThan(0)
      expect(out.texts.length).toBeGreaterThan(0)
      expect(out.excerpt.length).toBeGreaterThan(0)
      expect(out.readingMinutes).toBeGreaterThanOrEqual(1)
      expect(out.html).not.toMatch(/<(script|iframe|style)/i)
      for (const b of out.blocks) {
        expect(b.id).toMatch(/^[0-9a-f]{10}(-\d+)?$/)
        expect(b.hash).toMatch(/^[0-9a-f]{64}$/)
      }
      // The hashes are a contract: a change here means NORM_VERSION must be bumped.
      expect(out.blocks.map((b) => [b.id, b.tag, b.chars, b.skip ?? false])).toMatchSnapshot()
      expect(out.contentHash).toMatchSnapshot()
    })
  }

  test('every fixture article processes without throwing', async () => {
    for (const file of Object.keys(FIXTURE_FEEDS)) {
      const out = await firstArticle(file)
      expect(out.lang).not.toBe('und')
    }
  })
})
