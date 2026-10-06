/** A live answer keeps only its latest call's: answers do not come back in the order asked. */
import { describe, expect, test } from 'bun:test'
import { latestCalls } from '../src/lib/use-live'

describe('the latest call', () => {
  test('a call is the latest until another starts', () => {
    const start = latestCalls()
    const first = start()
    expect(first()).toBe(true)
    const second = start()
    // The first answers late, after the second was asked: it is dropped, whenever it lands.
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })

  test('each hook counts its own calls', () => {
    const badges = latestCalls()
    const overview = latestCalls()
    const counts = badges()
    overview()
    expect(counts()).toBe(true)
  })
})
