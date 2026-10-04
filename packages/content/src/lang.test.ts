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

  test('detects Latin-script languages with eld', () => {
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

  // Each of these was misread in production by tinyld, which eld replaced (Dutch, Tagalog, German).
  test('reads short English titles as English', () => {
    expect(detectLanguage('Open Social')).toBe('en')
    expect(detectLanguage('A Social Filesystem')).toBe('en')
  })

  test('reads through soft hyphens, which split words for a detector and not for a reader', () => {
    const hyphenated =
      'Thanks for your enthu\u00adsi\u00adastic response to the summer work\u00adshop: the whole edi\u00adtion sold out in a little over a day, and every post\u00adcard has now been dis\u00adpatched to the people who ordered one.'
    expect(detectLanguage(hyphenated)).toBe('en')
  })

  test('the hint breaks a near tie, and never overrides a clear answer', () => {
    // Malay and English score within 2% of each other on this line; the blog is English.
    expect(
      detectLanguage('16 conversations in super-multicultural Malaysia, Kuala Lumpur', 'en'),
    ).toBe('en')
    // A feed's declared tag can be a template default: a Chinese blog declaring en-US.
    expect(
      detectLanguage(
        'En la Calle de Toledo hay una panadería abierta desde 1928. A su alrededor la ciudad ha sido excavada, desviada y renombrada.',
        'en',
      ),
    ).toBe('es')
    expect(detectLanguage('这是一篇关于独立博客的文章，我们来聊聊为什么它还重要。', 'en')).toBe(
      'zh-Hans',
    )
  })

  test("a hint's Chinese script decides only when the text cannot", () => {
    // Traditional, but with none of the characters only one script has.
    const title = '今天台北的天氣很好'
    expect(detectLanguage(title, 'zh-TW')).toBe('zh-Hant')
    expect(detectLanguage(title, 'zh-Hant')).toBe('zh-Hant')
    expect(detectLanguage(title)).toBe('zh-Hans')
    expect(detectLanguage(title, 'zh-CN')).toBe('zh-Hans')
    expect(detectLanguage(title, 'en')).toBe('zh-Hans')
    // A clear answer stands against the hint, either way.
    expect(detectLanguage('我们这个软件的视频信息很好', 'zh-TW')).toBe('zh-Hans')
    expect(detectLanguage('我們這個軟體的影片資訊很好', 'zh-CN')).toBe('zh-Hant')
  })

  test('falls back to the hint for very short text', () => {
    expect(detectLanguage('Hi', 'de')).toBe('de')
    expect(detectLanguage('1234', null)).toBe('und')
  })
})
