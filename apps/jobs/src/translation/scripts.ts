/**
 * Traditional Chinese is never asked of the model: the model writes Simplified, OpenCC converts
 * it (Taiwan phrasing), and between the two Chinese scripts there is no model at all. Both
 * translation jobs plan a (source, reader language) pair through `planFor`.
 *
 * The shared block cache keeps only what a model wrote. A Traditional reader's text is converted
 * from the Simplified entry as it is read, and a conversion is never cached: it costs
 * microseconds, where a cache row costs a write and storage for ever, and only a model's output
 * is worth not paying for twice.
 */
import { checkPlaceholders } from '@tela/content/tagged'
import { type ScriptConversion, scriptConversion } from '@tela/llm'

/** The language the model writes for a reader of `lang`: Simplified for a Traditional reader. */
export function modelTarget(lang: string): string {
  return lang === 'zh-Hant' ? 'zh-Hans' : lang
}

export type Plan = {
  /**
   * The language a model writes for this reader, or null when the source is the other Chinese
   * script: the source itself is then what is converted, and nothing is asked of a model.
   */
  target: string | null
  /**
   * Makes what was written the reader's language: the identity, Simplified to Traditional after
   * the model, or with no model the source converted.
   */
  finish: ScriptConversion
  /** With no model, what is stored where a model's name would be. */
  label: string | null
}

const same: ScriptConversion = (text) => text

export function planFor(sourceLang: string | null, lang: string): Plan {
  const convert = scriptConversion(sourceLang, lang)
  if (convert) {
    return { target: null, finish: convert, label: lang === 'zh-Hant' ? 'opencc:twp' : 'opencc:cn' }
  }
  const target = modelTarget(lang)
  return { target, finish: scriptConversion(target, lang) ?? same, label: null }
}

/**
 * Convert tagged text, refusing a result whose placeholders differ from the source's. OpenCC
 * cannot touch them (they are ASCII, and no dictionary key holds `<`, `>`, `/` or a digit); this
 * is the guard that says so on every block rather than in a test alone.
 */
export function convertTagged(convert: ScriptConversion, text: string): string | undefined {
  if (convert === same) return text
  const converted = convert(text)
  return checkPlaceholders(text, converted).ok ? converted : undefined
}
