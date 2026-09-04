import { checkPlaceholders, plainText } from '@tela/content/tagged'

export type BlockCheck = { ok: true } | { ok: false; reason: string }

/** Below this many source characters, length and identity checks are skipped (names, labels). */
const SHORT_BLOCK = 20
const MIN_RATIO = 0.15
const MAX_RATIO = 6

/**
 * Accept a translated block only if it keeps the source's placeholders, is not empty, has a
 * plausible length, and is not just the source echoed back.
 */
export function validateTranslation(source: string, translated: string): BlockCheck {
  const placeholders = checkPlaceholders(source, translated)
  if (!placeholders.ok) return placeholders
  const src = plainText(source)
  const dst = plainText(translated)
  if (src.length > 0 && dst.length === 0) return { ok: false, reason: 'empty translation' }
  if (src.length >= SHORT_BLOCK) {
    const ratio = dst.length / src.length
    if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
      return { ok: false, reason: `length ratio ${ratio.toFixed(2)} is out of range` }
    }
    if (dst === src && /\p{L}/u.test(src)) return { ok: false, reason: 'identical to source' }
  }
  return { ok: true }
}
