/**
 * What a body translation is reckoned to spend (ADR 0057), shared by tela-api, which reserves it
 * against the site's day, and tela-jobs, which caps the source tokens a reservation pays for.
 *
 * What a body spends is what `usage_daily.used` counts: every call's input and output. A
 * reservation of source tokens alone held the day for well under half of that. So the estimate is
 * of the whole: the source sent, the translation written back (about 1.2 times the source), the
 * JSON around both and a strict retry of what failed, and each call's system prompt.
 */
import { MAX_ARTICLE_TRANSLATION_TOKENS } from './constants'

/** Tokens spent per source token: 1 sent, about 1.2 written back, 0.3 for JSON and retries. */
export const SPEND_PER_SOURCE_TOKEN = 2.5
/** Tokens each call spends besides its blocks: the system prompt (about 550), and some again. */
export const PROMPT_TOKENS_PER_CHUNK = 1000
/** The opening chunk tela-jobs streams: small, so the first paragraphs land in seconds. */
export const FIRST_CHUNK_TOKENS = 400
/** Source tokens in each chunk after the first. */
export const CHUNK_TOKENS = 3000

/** The chunks `sourceTokens` are sent in: one small, then full ones (an upper bound). */
function chunksFor(sourceTokens: number): number {
  if (sourceTokens <= 0) return 0
  return 1 + Math.ceil(Math.max(0, sourceTokens - FIRST_CHUNK_TOKENS) / CHUNK_TOKENS)
}

/** Tokens a body of `sourceTokens` to translate is reckoned to spend, input and output. */
export function bodySpendFor(sourceTokens: number): number {
  const source = Math.max(0, Math.ceil(sourceTokens))
  return Math.ceil(source * SPEND_PER_SOURCE_TOKEN) + PROMPT_TOKENS_PER_CHUNK * chunksFor(source)
}

/** The most a body is reserved: the whole spend of a post at the per-post ceiling. */
export const MAX_BODY_SPEND = bodySpendFor(MAX_ARTICLE_TRANSLATION_TOKENS)

/**
 * The most source tokens a reservation of `spend` pays for: the inverse of `bodySpendFor`, so a
 * body reserved for `n` source tokens is translated up to `n` of them, never cut short by its own
 * prompt and output, and never past what its reservation reckoned.
 */
export function sourceTokensFor(spend: number): number {
  let lo = 0
  let hi = Math.max(0, Math.floor(spend))
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (bodySpendFor(mid) <= spend) lo = mid
    else hi = mid - 1
  }
  return lo
}
