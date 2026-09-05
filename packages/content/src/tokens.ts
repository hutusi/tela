const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/**
 * Rough source-token estimate: one per CJK character, one per four other characters. Shared by
 * the worker's chunking and the web app's reservations so both count the same way.
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK) ?? []).length
  return cjk + Math.ceil((text.length - cjk) / 4)
}
