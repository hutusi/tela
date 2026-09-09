import { describe, expect, test } from 'bun:test'
import { showsTranslation } from './shows-translation'

describe('showsTranslation', () => {
  test('a foreign post with a translated title is shown translated', () => {
    expect(showsTranslation('en', 'zh-Hans', '大语言模型 0.35')).toBe(true)
  })

  test('a foreign post with no translated title is not', () => {
    // The title job failed and wrote no row; the badge used to appear anyway.
    expect(showsTranslation('en', 'zh-Hans', null)).toBe(false)
  })

  test('a post already in the reading language is not, translated title or no', () => {
    expect(showsTranslation('zh-Hans', 'zh-Hans', '标题')).toBe(false)
    // Regions differ, language does not.
    expect(showsTranslation('zh-Hans', 'zh-Hant', '标题')).toBe(false)
    expect(showsTranslation('en-GB', 'en', 'Title')).toBe(false)
  })

  test('an undetected source language is never claimed as translated', () => {
    expect(showsTranslation(null, 'zh-Hans', '标题')).toBe(false)
  })
})
