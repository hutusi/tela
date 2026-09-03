import { describe, expect, test } from 'bun:test'
import { detectLanguage, normalizeLangTag } from './lang'

describe('lang', () => {
  test('normalizes tags', () => {
    expect(normalizeLangTag('zh-CN')).toBe('zh-Hans')
    expect(normalizeLangTag('zh_TW')).toBe('zh-Hant')
    expect(normalizeLangTag('en-US')).toBe('en')
    expect(normalizeLangTag('')).toBeNull()
  })

  test('detects CJK by script', () => {
    expect(detectLanguage('这是一篇关于独立博客的文章，我们来聊聊为什么它还重要。')).toBe('zh-Hans')
    expect(detectLanguage('這是一篇關於獨立部落格的文章，我們來聊聊為什麼它還重要。')).toBe(
      'zh-Hant',
    )
    expect(detectLanguage('台風が予報されていたが、来なかった。正午には港は満杯だった。')).toBe(
      'ja',
    )
    expect(detectLanguage('독립 블로그에 대한 글입니다. 왜 여전히 중요한지 이야기해 봅시다.')).toBe(
      'ko',
    )
  })

  test('detects Latin-script languages with tinyld', () => {
    expect(
      detectLanguage(
        'On Calle de Toledo there is a bakery that has been open since 1928. Around it the city has been dug up, rerouted and renamed. The bread has not changed.',
      ),
    ).toBe('en')
    expect(
      detectLanguage(
        'En la Calle de Toledo hay una panadería abierta desde 1928. A su alrededor la ciudad ha sido excavada, desviada y renombrada.',
      ),
    ).toBe('es')
  })

  test('falls back to the hint for very short text', () => {
    expect(detectLanguage('Hi', 'de')).toBe('de')
    expect(detectLanguage('1234', null)).toBe('und')
  })
})
