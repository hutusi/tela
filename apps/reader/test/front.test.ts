import { describe, expect, test } from 'bun:test'
import { editionTitles, frontHref, pickLead, titlesMode } from '../src/lib/edition'
import { nameIn, nativeName } from '../src/lib/language-name'
import type { FrontPost } from '../src/views/types'

function post(
  id: number,
  article: Partial<FrontPost['article']> = {},
  site: Partial<FrontPost['site']> = {},
): FrontPost {
  return {
    article: {
      id,
      feedId: id,
      url: `https://blog${id}.example/p`,
      title: `Post ${id}`,
      author: null,
      publishedAt: 0,
      fetchedAt: 0,
      sortAt: 0,
      sourceLang: 'en',
      excerpt: null,
      contentKey: null,
      wordCount: 0,
      readingMinutes: 1,
      extractState: 'done',
      likeCount: 0,
      recommendCount: 0,
      seq: 0,
      ...article,
    },
    site: {
      id,
      title: `Blog ${id}`,
      homeUrl: `https://blog${id}.example`,
      faviconKey: null,
      primaryLang: 'en',
      ...site,
    },
    claimant: null,
  }
}

describe('the lead', () => {
  test('is the first post worth three minutes that has an excerpt, else the newest', () => {
    const short = post(1, { readingMinutes: 2, excerpt: 'Short.' })
    const bare = post(2, { readingMinutes: 9 })
    const long = post(3, { readingMinutes: 4, excerpt: 'Long and worth it.' })
    const later = post(4, { readingMinutes: 12, excerpt: 'Also long.' })
    expect(pickLead([short, bare, long, later])).toBe(long)
    expect(pickLead([short, bare])).toBe(short)
    expect(pickLead([])).toBeNull()
  })
})

describe("the edition's titles", () => {
  const spanish = post(1, {
    title: 'La ciudad de noche',
    sourceLang: 'es',
    excerpt: 'Un paseo largo.',
    titles: { en: 'The city at night', 'zh-Hans': '夜晚的城市' },
    excerpts: { en: 'A long walk.' },
  }).article

  test('open as written, with the translation small and the language in its own name', () => {
    expect(editionTitles(spanish, 'original', 'en', 'en')).toEqual({
      big: { text: 'La ciudad de noche', lang: 'es' },
      small: { text: 'The city at night', lang: 'en' },
      excerpt: { text: 'Un paseo largo.', lang: 'es' },
      label: 'Español',
    })
  })

  test("translated, swap: the reader's language large, the excerpt too, and its name for the language", () => {
    expect(editionTitles(spanish, 'translated', 'en', 'en')).toEqual({
      big: { text: 'The city at night', lang: 'en' },
      small: { text: 'La ciudad de noche', lang: 'es' },
      excerpt: { text: 'A long walk.', lang: 'en' },
      label: 'Spanish',
    })
    const zh = editionTitles(spanish, 'translated', 'zh-Hans', 'zh-Hans')
    expect(zh.big).toEqual({ text: '夜晚的城市', lang: 'zh-Hans' })
    // No Chinese excerpt: the one as written, marked as what it is.
    expect(zh.excerpt).toEqual({ text: 'Un paseo largo.', lang: 'es' })
    expect(zh.label).toBe('西班牙语')
  })

  test("a post in the reader's language, or not yet translated, has one title in either mode", () => {
    const english = post(2, { title: 'Hello', sourceLang: 'en', titles: { 'zh-Hans': '你好' } })
    for (const mode of ['original', 'translated'] as const) {
      const shown = editionTitles(english.article, mode, 'en', 'en')
      expect(shown.big).toEqual({ text: 'Hello', lang: 'en' })
      expect(shown.small).toBeNull()
    }
    const untranslated = post(3, { title: '日記', sourceLang: 'ja' }).article
    expect(editionTitles(untranslated, 'translated', 'en', 'en')).toMatchObject({
      big: { text: '日記', lang: 'ja' },
      small: null,
      label: 'Japanese',
    })
    // A language nobody detected: no label, and no `lang` to claim.
    const unknown = editionTitles(post(4, { sourceLang: null }).article, 'original', 'en', 'en')
    expect(unknown.label).toBeNull()
    expect(unknown.big.lang).toBeUndefined()
  })

  test('the mode is in the address, and only `translated` is not the default', () => {
    expect(titlesMode(new URLSearchParams('titles=translated'))).toBe('translated')
    expect(titlesMode(new URLSearchParams('titles=other'))).toBe('original')
    expect(frontHref('original')).toBe('/')
    expect(frontHref('translated')).toBe('/?titles=translated')
  })
})

describe('language names', () => {
  test('in the language itself, capitalised as a label starts', () => {
    expect(nativeName('es')).toBe('Español')
    expect(nativeName('fr')).toBe('Français')
    expect(nativeName('zh-Hans')).toBe('简体中文')
    expect(nativeName('zh-Hant')).toBe('繁體中文')
    expect(nativeName('ja')).toBe('日本語')
    expect(nativeName('ko')).toBe('한국어')
  })

  test("in the reader's language, from Tela's own list first", () => {
    expect(nameIn('es', 'en')).toBe('Spanish')
    expect(nameIn('zh-Hans', 'en')).toBe('Chinese (Simplified)')
    expect(nameIn('es', 'zh-Hans')).toBe('西班牙语')
    expect(nameIn('en', 'en')).toBe('English')
  })

  test('a tag no runtime knows is shown as itself', () => {
    expect(nativeName('not a tag')).toBe('not a tag')
    expect(nameIn('not a tag', 'en')).toBe('not a tag')
  })
})
