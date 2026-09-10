import { checkPlaceholders, plainText } from '@tela/content/tagged'

export type BlockCheck =
  /** `identical` marks a block accepted only because `allowIdentical` permitted an echo. */
  { ok: true; identical?: boolean } | { ok: false; reason: string }

export type ValidateOptions = {
  /**
   * Accept a translation identical to its source. A title is often a name, a package or a
   * version string whose correct rendering in any language is itself ("llm-openrouter 0.7.1"),
   * and rejecting those left the post with no translated title at all rather than a faithful one.
   */
  allowIdentical?: boolean
}

/** Below this many source characters, length and identity checks are skipped (names, labels). */
const SHORT_BLOCK = 20
const MIN_RATIO = 0.15
const MAX_RATIO = 6

/**
 * Accept a translated block only if it keeps the source's placeholders, is not empty, has a
 * plausible length, and is not just the source echoed back -- unless `allowIdentical` says an
 * echo is a legitimate answer for this block.
 */
export function validateTranslation(
  source: string,
  translated: string,
  options: ValidateOptions = {},
): BlockCheck {
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
    if (dst === src && /\p{L}/u.test(src)) {
      if (!options.allowIdentical) return { ok: false, reason: 'identical to source' }
      return { ok: true, identical: true }
    }
  }
  return { ok: true }
}
