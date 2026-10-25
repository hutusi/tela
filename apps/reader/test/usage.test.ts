/**
 * A member's limits as the reader meets them (ADR 0063): the usage answer it keeps per account,
 * the check it makes before subscribing (the server refuses past the cap without a word), the
 * refusals and the import summary it words.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { daysToArrive } from '@tela/shared'
import {
  emptyTables,
  MEMBER_HEADER,
  pastSubscriptionCap,
  type SubscriptionRow,
  type Tables,
} from '@tela/sync'
import { createTranslator } from 'use-intl'
import en from '../messages/en.json'
import { capRefusal } from '../src/lib/member'
import { addProblem, readImported } from '../src/lib/opml'
import { fetchUsage, forgetUsage, readUsage, subscriptionCap } from '../src/lib/usage'

const USAGE = {
  translations: { perDay: 20, usedToday: 3, waiting: 1, resetsAt: Date.UTC(2026, 9, 26) },
  feeds: { perDay: 20, addedToday: 2, pending: 48 },
  subscriptions: { max: 300, count: 299 },
  exempt: false,
}

/** Tables holding `live` subscriptions and `gone` unsubscribed ones. */
function holding(live: number, gone = 0): Pick<Tables, 'subscriptions'> {
  const t = emptyTables()
  for (let i = 1; i <= live + gone; i++) {
    const row: SubscriptionRow = {
      feedId: i,
      watermarkId: 0,
      createdAt: 0,
      deletedAt: i > live ? 1 : null,
      seq: 0,
    }
    t.subscriptions.set(i, row)
  }
  return t
}

const saved = globalThis.fetch
afterAll(() => {
  globalThis.fetch = saved
})
afterEach(() => forgetUsage())

describe('the usage answer', () => {
  test('is read in the shape tela-api sends, and nothing else', () => {
    expect(readUsage(USAGE)).toEqual(USAGE)
    expect(readUsage({ ...USAGE, exempt: true, subscriptions: { max: null, count: 4 } })).toEqual({
      ...USAGE,
      exempt: true,
      subscriptions: { max: null, count: 4 },
    })
    expect(readUsage({ ...USAGE, subscriptions: { max: '300', count: 1 } })).toBe(null)
    expect(readUsage({ translations: USAGE.translations })).toBe(null)
    expect(readUsage(null)).toBe(null)
  })

  test('is kept for the account that asked, named in the call', async () => {
    const asked: (string | null)[] = []
    globalThis.fetch = (async (_input: string, init?: RequestInit) => {
      asked.push(new Headers(init?.headers).get(MEMBER_HEADER))
      return new Response(JSON.stringify(USAGE), { status: 200 })
    }) as typeof fetch
    expect(subscriptionCap('u1')).toBe(null)
    expect(await fetchUsage('u1')).toEqual(USAGE)
    expect(asked).toEqual(['u1'])
    expect(subscriptionCap('u1')).toBe(300)
    // Another account in this tab never reads it.
    expect(subscriptionCap('u2')).toBe(null)
    expect(subscriptionCap(null)).toBe(null)
  })

  test('an answer that does not come leaves nothing to refuse by', async () => {
    globalThis.fetch = (async (_input: string) =>
      new Response('busy', { status: 503 })) as unknown as typeof fetch
    expect(await fetchUsage('u1')).toBe(null)
    expect(subscriptionCap('u1')).toBe(null)
  })
})

describe('before subscribing', () => {
  test('past the cap is refused, counting only what is followed now', () => {
    expect(pastSubscriptionCap(holding(299, 5), 300, 1)).toBe(false)
    expect(pastSubscriptionCap(holding(300), 300, 1)).toBe(true)
    expect(pastSubscriptionCap(holding(300), null, 1)).toBe(false)
    expect(pastSubscriptionCap(holding(300), 300, 0)).toBe(false)
  })

  test('one blog says the cap; several say how many still fit', () => {
    expect(capRefusal(holding(10), 300, 1)).toBe(null)
    expect(capRefusal(holding(10), null, 500)).toBe(null)
    expect(capRefusal(holding(300), 300, 1)).toEqual({
      message: 'subscriptionLimit',
      values: { max: 300 },
    })
    expect(capRefusal(holding(296), 300, 12)).toEqual({
      message: 'subscriptionLimitMany',
      values: { n: 12, max: 300, room: 4 },
    })
    expect(capRefusal(holding(300), 300, 12)).toEqual({
      message: 'subscriptionLimit',
      values: { max: 300 },
    })
  })
})

describe('adding blogs', () => {
  test('a refusal carries its limit, and an unknown one is a failure to reach', () => {
    expect(addProblem({ error: 'feed_limit', limit: 20, resetsAt: 5 })).toEqual({
      error: 'feed_limit',
      limit: 20,
      resetsAt: 5,
    })
    expect(addProblem({ error: 'subscription_limit', limit: 300 })).toEqual({
      error: 'subscription_limit',
      limit: 300,
    })
    expect(addProblem({ error: 'something_new' })).toEqual({ error: 'fetch_failed' })
    expect(addProblem(null)).toEqual({ error: 'fetch_failed' })
  })

  test("an import's answer keeps what it says, and one from an older tela-api only its count", () => {
    expect(readImported({ feeds: 4, subscribed: 4, folders: 0, filed: 0 })).toEqual({ feeds: 4 })
    expect(
      readImported({
        feeds: 20,
        added: 18,
        waiting: 48,
        over: 0,
        perDay: 20,
        maxSubscriptions: 300,
      }),
    ).toEqual({ feeds: 20, added: 18, waiting: 48, over: 0, perDay: 20, maxSubscriptions: 300 })
    expect(readImported({ error: 'opml_invalid' })).toBe(null)
  })

  test('the summary says when the blogs that wait arrive', () => {
    const t = createTranslator({ locale: 'en', messages: en })
    expect(daysToArrive(48, 20)).toBe(3)
    expect(daysToArrive(20, 20)).toBe(1)
    expect(daysToArrive(5, 0)).toBe(null)
    expect(t('add.importWaiting', { perDay: 20, n: 48, days: 3 })).toBe(
      'Tela adds 20 new blogs a day for you; the other 48 arrive over the next 3 days.',
    )
    expect(t('add.importWaiting', { perDay: 20, n: 1, days: 1 })).toBe(
      'Tela adds 20 new blogs a day for you; the other one arrives tomorrow.',
    )
    expect(t('toast.subscriptionLimit', { max: 300 })).toBe(
      'You follow 300 blogs, the most one account holds. Unsubscribe from one to add another.',
    )
    expect(t('add.errors.feed_limit', { limit: 0, time: '08:00' })).toBe(
      'Tela isn’t taking blogs new to it right now. Blogs already on Tela can still be added.',
    )
  })
})
