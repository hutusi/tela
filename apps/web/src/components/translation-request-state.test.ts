import { describe, expect, test } from 'bun:test'
import { translationRequestDecision } from './translation-request-state'

describe('translationRequestDecision', () => {
  test('polls only after work was accepted or was already in progress', () => {
    expect(translationRequestDecision('requested')).toEqual({ poll: true })
    expect(translationRequestDecision('in_progress')).toEqual({ poll: true })
  })

  test('refreshes an already-ready race without starting a poller', () => {
    expect(translationRequestDecision('ready')).toEqual({ refresh: true })
  })

  test('shows admission failures without polling', () => {
    expect(translationRequestDecision('rate_limited')).toEqual({ notice: 'rateLimited' })
    expect(translationRequestDecision('budget_exhausted')).toEqual({
      notice: 'budgetExhausted',
    })
    expect(translationRequestDecision('unavailable')).toEqual({ notice: 'unavailable' })
  })

  test('does nothing for an invalid request', () => {
    expect(translationRequestDecision('invalid')).toEqual({})
  })
})
