import type { TranslationRequestOutcome } from '@/app/reading/actions'

export type TranslationRequestNotice = 'rateLimited' | 'budgetExhausted' | 'unavailable'

export type TranslationRequestDecision = {
  poll?: true
  refresh?: true
  notice?: TranslationRequestNotice
}

/** Turn a request outcome into mutually exclusive client work. */
export function translationRequestDecision(
  outcome: TranslationRequestOutcome,
): TranslationRequestDecision {
  if (outcome === 'requested' || outcome === 'in_progress') return { poll: true }
  if (outcome === 'ready') return { refresh: true }
  if (outcome === 'rate_limited') return { notice: 'rateLimited' }
  if (outcome === 'budget_exhausted') return { notice: 'budgetExhausted' }
  if (outcome === 'unavailable') return { notice: 'unavailable' }
  return {}
}
