import { eld } from 'eld/extrasmall'

const HAN = /\p{Script=Han}/gu
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu
const HANGUL = /\p{Script=Hangul}/gu
const LETTER = /\p{L}/gu
// Soft hyphens and zero-width marks split a word for a detector and not for a reader: tinyld read
// a hyphenated English newsletter as German.
const INVISIBLE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g
const LINK = /https?:\/\/\S+/g
/** The hint wins when it scores within this share of the best guess: the text cannot say. */
const HINT_TIE = 0.9

// Characters that exist only in one of the two Chinese writing systems.
const SIMPLIFIED_ONLY = '们这说为于后与个么来时会国对发经过还样开动进关问题实现电体术'
const TRADITIONAL_ONLY = '們這說為於後與個麼來時會國對發經過還樣開動進關問題實現電體術'

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length
}

/** Map a feed-provided or detected tag onto the tags Tela uses. */
export function normalizeLangTag(tag: string | null | undefined): string | null {
  if (!tag) return null
  const t = tag.trim().toLowerCase().replace('_', '-')
  if (!t) return null
  if (t === 'zh' || t === 'zh-cn' || t === 'zh-sg' || t === 'zh-hans' || t.startsWith('zh-hans-')) {
    return 'zh-Hans'
  }
  if (
    t === 'zh-tw' ||
    t === 'zh-hk' ||
    t === 'zh-mo' ||
    t === 'zh-hant' ||
    t.startsWith('zh-hant-')
  ) {
    return 'zh-Hant'
  }
  return t.split('-')[0] ?? null
}

function chineseVariant(text: string): 'zh-Hans' | 'zh-Hant' {
  let simp = 0
  let trad = 0
  for (const ch of text) {
    if (SIMPLIFIED_ONLY.includes(ch)) simp++
    else if (TRADITIONAL_ONLY.includes(ch)) trad++
  }
  return trad > simp ? 'zh-Hant' : 'zh-Hans'
}

/**
 * Detect the language of an article. Script ratios decide CJK cases; eld (60 languages) guesses
 * the rest. `hint` (the item's declared language, else the blog's) decides very short text and
 * breaks a near tie, and never overrides a clear answer: declared tags can be wrong, as a
 * Chinese blog declaring `en-US` shows.
 */
export function detectLanguage(text: string, hint?: string | null): string {
  const sample = text.replace(INVISIBLE, '').replace(LINK, ' ').slice(0, 4000)
  const letters = count(sample, LETTER)
  const normalizedHint = normalizeLangTag(hint)
  if (letters === 0) return normalizedHint ?? 'und'

  const kana = count(sample, KANA)
  const hangul = count(sample, HANGUL)
  const han = count(sample, HAN)
  if (kana / letters >= 0.05) return 'ja'
  if (hangul / letters >= 0.2) return 'ko'
  if (han / letters >= 0.3) return chineseVariant(sample)

  if (letters < 20 && normalizedHint) return normalizedHint
  const result = eld.detect(sample)
  if (!result.language) return normalizedHint ?? 'und'
  let guess = result.language
  if (normalizedHint) {
    const scores = result.getScores()
    const hinted = normalizedHint.startsWith('zh-') ? 'zh' : normalizedHint
    if ((scores[hinted] ?? 0) >= (scores[guess] ?? 0) * HINT_TIE) guess = hinted
  }
  if (guess === 'zh') return chineseVariant(sample)
  return normalizeLangTag(guess) ?? 'und'
}
