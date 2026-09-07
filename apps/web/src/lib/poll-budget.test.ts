import { describe, expect, test } from 'bun:test'
import { createPollBudget } from './poll-budget'

function fakeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('createPollBudget', () => {
  test('counts the time it runs for', () => {
    const c = fakeClock()
    const budget = createPollBudget(1000, c.now)
    c.advance(400)
    expect(budget.spentMs()).toBe(400)
    expect(budget.exhausted()).toBe(false)
    c.advance(600)
    expect(budget.exhausted()).toBe(true)
  })

  test('does not count time while paused, so a backgrounded tab keeps its window', () => {
    const c = fakeClock()
    const budget = createPollBudget(1000, c.now)
    c.advance(200)
    budget.pause()
    c.advance(10 * 60_000)
    expect(budget.spentMs()).toBe(200)
    expect(budget.exhausted()).toBe(false)
    budget.resume()
    c.advance(300)
    expect(budget.spentMs()).toBe(500)
    expect(budget.exhausted()).toBe(false)
  })

  test('pause and resume are idempotent', () => {
    const c = fakeClock()
    const budget = createPollBudget(1000, c.now)
    budget.pause()
    budget.pause()
    c.advance(500)
    budget.resume()
    budget.resume()
    c.advance(100)
    expect(budget.spentMs()).toBe(100)
  })
})
