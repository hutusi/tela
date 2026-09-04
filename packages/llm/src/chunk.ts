import type { TranslationBlock } from './types'

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/** Rough token estimate: one per CJK character, one per four other characters. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK) ?? []).length
  return cjk + Math.ceil((text.length - cjk) / 4)
}

export const DEFAULT_CHUNK_TOKENS = 3000

/**
 * Group consecutive blocks into chunks of at most `maxTokens` source tokens. Most posts fit
 * one chunk; an oversized block travels alone rather than being split, so its cache key
 * stays intact.
 */
export function chunkBlocks(
  blocks: TranslationBlock[],
  maxTokens = DEFAULT_CHUNK_TOKENS,
): TranslationBlock[][] {
  const chunks: TranslationBlock[][] = []
  let current: TranslationBlock[] = []
  let size = 0
  for (const block of blocks) {
    const tokens = estimateTokens(block.text)
    if (current.length > 0 && size + tokens > maxTokens) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(block)
    size += tokens
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
