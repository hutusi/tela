import { describe, expect, test } from 'bun:test'
import { displayTitle, showsTranslationBadge } from './shows-translation'

describe('displayTitle', () => {
  test('prefers the translation whenever we hold one', () => {
    expect(displayTitle('llm 0.35', '大语言模型 0.35')).toBe('大语言模型 0.35')
    expect(displayTitle('llm 0.35', null)).toBe('llm 0.35')
  })

  test('does not consult the language pair, unlike the badge', () => {
    // Search matches translated_title in SQL and the worker queues these translations, so
    // hiding them renders a hit that does not contain what the reader typed.
    expect(displayTitle('繁體標題', '简体标题')).toBe('简体标题')
    expect(showsTranslationBadge('zh-Hant', 'zh-Hans', '简体标题')).toBe(false)
    expect(displayTitle('Undetected source', '未知来源')).toBe('未知来源')
    expect(showsTranslationBadge(null, 'zh-Hans', '未知来源')).toBe(false)
  })
})

describe('showsTranslationBadge', () => {
  test('a foreign post with a translated title is badged', () => {
    expect(showsTranslationBadge('en', 'zh-Hans', '大语言模型 0.35')).toBe(true)
  })

  test('a foreign post with no translated title is not', () => {
    // The title job failed and wrote no row; the badge used to appear anyway.
    expect(showsTranslationBadge('en', 'zh-Hans', null)).toBe(false)
  })

  test('a post already in the reading language is not, translated title or no', () => {
    expect(showsTranslationBadge('zh-Hans', 'zh-Hans', '标题')).toBe(false)
    expect(showsTranslationBadge('en-GB', 'en', 'Title')).toBe(false)
  })
})
