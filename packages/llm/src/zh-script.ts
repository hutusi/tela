/**
 * Chinese script conversion. Traditional Chinese is never asked of the model: the model writes
 * Simplified, and OpenCC's dictionaries convert it, with Taiwan phrasing (`cn → twp`: 软件 → 軟體,
 * 视频 → 影片). A post written in one script reaches a reader of the other by conversion alone,
 * with no call (ADR 0038).
 *
 * It cannot break tagged text: placeholders (`<g1>`, `</g1>`, `<x1/>`) and entities (`&lt;`,
 * `&amp;`) are ASCII, and no key in the dictionaries used here contains `<`, `>`, `/`, `&`, `;`, a
 * digit or a lowercase letter.
 *
 * The dictionaries are opencc-js's; the matcher is ours. Each step of the chain replaces the
 * longest dictionary key starting at each position, as opencc-js's `ConverterFactory` does, but
 * from one flat `Map` per step instead of a trie of nested `Map`s: about 5 MB of heap for
 * Simplified → Traditional instead of 21 MB (`ConverterFactory`) or 40 MB (`Converter`, which also
 * segments first). tela-jobs runs in 128 MB. Output is identical to `ConverterFactory`'s on every
 * phrase key in the dictionary and on the Simplified catalogs. Building it takes about 15 ms, and
 * converting a 4,000-character body about 1 ms.
 */
import { Locale } from 'opencc-js'

export type ScriptConversion = (text: string) => string

type DictGroup = (typeof Locale.from)[string][number]

/** One step of a chain: every key of a dictionary group, and the longest key per first code point. */
type Step = { map: Map<string, string>; longest: Map<number, number> }

function step(group: DictGroup): Step {
  const map = new Map<string, string>()
  const longest = new Map<number, number>()
  // The first dictionary of a group wins over the later ones, as opencc-js loads them.
  for (const dict of [...group].reverse()) {
    const entries =
      typeof dict === 'string'
        ? dict.split('|').map((e) => {
            const space = e.indexOf(' ')
            return [e.slice(0, space), e.slice(space + 1)] as const
          })
        : dict
    for (const [from, to] of entries) {
      if (!from) continue
      map.set(from, to)
      const first = from.codePointAt(0) as number
      if ((longest.get(first) ?? 0) < from.length) longest.set(first, from.length)
    }
  }
  return { map, longest }
}

function run({ map, longest }: Step, text: string): string {
  const parts: string[] = []
  let i = 0
  let copied = 0
  while (i < text.length) {
    const code = text.codePointAt(i) as number
    let matched = 0
    let value: string | undefined
    for (let length = Math.min(longest.get(code) ?? 0, text.length - i); length > 0; length--) {
      value = map.get(text.slice(i, i + length))
      if (value !== undefined) {
        matched = length
        break
      }
    }
    if (matched > 0) {
      if (copied < i) parts.push(text.slice(copied, i))
      parts.push(value as string)
      i += matched
      copied = i
    } else {
      i += code > 0xffff ? 2 : 1
    }
  }
  parts.push(text.slice(copied))
  return parts.join('')
}

function chain(groups: readonly DictGroup[]): ScriptConversion {
  const steps = groups.map(step)
  return (text) => steps.reduce((converted, s) => run(s, converted), text)
}

let traditional: ScriptConversion | undefined
let simplified: ScriptConversion | undefined

/** Simplified to Traditional with Taiwan phrasing (OpenCC `cn → twp`). */
export function toTraditional(text: string): string {
  traditional ??= chain([...(Locale.from.cn ?? []), ...(Locale.to.twp ?? [])])
  return traditional(text)
}

/**
 * Traditional, Taiwan phrasing included, to Simplified with mainland phrasing (OpenCC
 * `twp → cn`): 軟體 → 软件, the mirror of `toTraditional`.
 */
export function toSimplified(text: string): string {
  simplified ??= chain([...(Locale.from.twp ?? []), ...(Locale.to.cn ?? [])])
  return simplified(text)
}

/**
 * How text in `sourceLang` becomes `targetLang` without a model, or null when it cannot: only
 * between the two Chinese scripts. Tags are compared exactly (stored tags are normalized).
 */
export function scriptConversion(
  sourceLang: string | null,
  targetLang: string,
): ScriptConversion | null {
  if (sourceLang === 'zh-Hans' && targetLang === 'zh-Hant') return toTraditional
  if (sourceLang === 'zh-Hant' && targetLang === 'zh-Hans') return toSimplified
  return null
}
