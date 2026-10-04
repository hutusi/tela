import { describe, expect, test } from 'bun:test'
import { checkPlaceholders, tokenize } from '@tela/content/tagged'
import { ConverterFactory, Locale } from 'opencc-js'
import { scriptConversion, toSimplified, toTraditional } from './zh-script'

/** Every key of a chain's first dictionary group, run together: each phrase OpenCC knows. */
function phrases(groups: (typeof Locale.from)[string]): string {
  const keys: string[] = []
  for (const dict of groups[0] ?? []) {
    if (typeof dict !== 'string') continue
    for (const entry of dict.split('|')) keys.push(entry.slice(0, entry.indexOf(' ')))
  }
  return keys.join('，')
}

describe('Chinese script conversion', () => {
  test('Traditional takes Taiwan phrasing, not only Traditional characters', () => {
    expect(toTraditional('软件')).toBe('軟體')
    expect(toTraditional('视频')).toBe('影片')
    expect(toTraditional('信息')).toBe('資訊')
    expect(toTraditional('服务器和数据库')).toBe('伺服器和資料庫')
    expect(toTraditional('我们今天讨论一下这个问题。')).toBe('我們今天討論一下這個問題。')
  })

  test('Simplified takes mainland phrasing back', () => {
    expect(toSimplified('軟體')).toBe('软件')
    expect(toSimplified('資訊')).toBe('信息')
    expect(toSimplified('伺服器和資料庫')).toBe('服务器和数据库')
    expect(toSimplified('我們今天討論一下這個問題。')).toBe('我们今天讨论一下这个问题。')
  })

  test('text whose characters both scripts share is left as it is', () => {
    for (const text of ['中文', '天下', '可以', '日本人口', 'Hello, world 123']) {
      expect(toTraditional(text)).toBe(text)
      expect(toSimplified(text)).toBe(text)
    }
  })

  test('tagged text keeps every placeholder and entity', () => {
    const source = '<g1>软件</g1>开发<x1/>和&lt;视频&gt; &amp; <g2>信息<g3>网络</g3></g2>&quot;'
    const converted = toTraditional(source)
    expect(converted).toBe(
      '<g1>軟體</g1>開發<x1/>和&lt;影片&gt; &amp; <g2>資訊<g3>網路</g3></g2>&quot;',
    )
    expect(checkPlaceholders(source, converted)).toEqual({ ok: true })
    const markup = (text: string) => tokenize(text).filter((t) => t.kind !== 'text')
    expect(markup(converted)).toEqual(markup(source))
    expect(toSimplified(converted)).toBe(source)
  })

  test("the flat matcher converts as opencc-js's own does, phrase for phrase", () => {
    const cn = Locale.from.cn ?? []
    const twp = Locale.from.twp ?? []
    const traditional = ConverterFactory([...cn], ...(Locale.to.twp ?? []))
    const simplified = ConverterFactory([...twp], ...(Locale.to.cn ?? []))
    const simplifiedText = phrases(cn)
    const traditionalText = phrases(twp)
    expect(simplifiedText.length).toBeGreaterThan(100_000)
    expect(toTraditional(simplifiedText)).toBe(traditional(simplifiedText))
    expect(toSimplified(traditionalText)).toBe(simplified(traditionalText))
  })

  test('only the two Chinese scripts convert into each other', () => {
    expect(scriptConversion('zh-Hans', 'zh-Hant')).toBe(toTraditional)
    expect(scriptConversion('zh-Hant', 'zh-Hans')).toBe(toSimplified)
    expect(scriptConversion('en', 'zh-Hant')).toBeNull()
    expect(scriptConversion(null, 'zh-Hant')).toBeNull()
    expect(scriptConversion('zh-Hans', 'en')).toBeNull()
    expect(scriptConversion('zh-Hant', 'zh-Hant')).toBeNull()
  })
})
