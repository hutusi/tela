/** Settings › Subscriptions as a manager (ADR 0049): latest posts, orders, the filter and ticks. */
import { describe, expect, test } from 'bun:test'
import { emptyTables, type FeedRow, type Tables } from '@tela/sync'
import {
  clickRow,
  compareBy,
  fold,
  hiddenTicks,
  latestPosts,
  matcher,
  NO_TICKS,
  postedAgo,
  type Sortable,
  standing,
  tickedState,
  toggleAll,
} from '../src/lib/subscriptions'
import { article, DAY, NOW } from './rows'

const feed = (id: number, over: Partial<FeedRow> = {}): FeedRow => ({
  id,
  siteId: id,
  feedUrl: `https://blog${id}.example/feed`,
  title: null,
  status: 'active',
  lastFetchedAt: null,
  lastError: null,
  seq: 1,
  ...over,
})

function tables(feeds: FeedRow[], articles = [] as ReturnType<typeof article>[]): Tables {
  const t = emptyTables()
  for (const f of feeds) t.feeds.set(f.id, f)
  for (const a of articles) t.articles.set(a.id, a)
  return t
}

describe('latestPosts', () => {
  test("a blog quiet past the device's horizon is dated by its feed row", () => {
    const t = tables([feed(1, { lastItemAt: NOW - 300 * DAY })])
    expect(latestPosts(t).get(1)).toBe(NOW - 300 * DAY)
  })

  test('a post the device holds that is newer than the feed row says wins', () => {
    const t = tables(
      [feed(1, { lastItemAt: NOW - 10 * DAY })],
      [article(1, { feedId: 1, publishedAt: NOW - 2 * DAY })],
    )
    expect(latestPosts(t).get(1)).toBe(NOW - 2 * DAY)
  })

  test('a feed row from an older tela-api, with no date, falls back to the posts held', () => {
    const t = tables([feed(1)], [article(1, { feedId: 1, publishedAt: null, sortAt: NOW - DAY })])
    expect(latestPosts(t).get(1)).toBe(NOW - DAY)
  })

  test('a blog nothing dates is absent', () => {
    expect(latestPosts(tables([feed(1, { lastItemAt: null })])).has(1)).toBe(false)
  })
})

describe('postedAgo', () => {
  const ago = (days: number, locale = 'en') => postedAgo(NOW - days * DAY, locale, NOW)

  test('reads as the design has it, in English', () => {
    expect(ago(0.2)).toBe('Today')
    expect(ago(1.5)).toBe('Yesterday')
    expect(ago(3)).toBe('3 days ago')
    expect(ago(8)).toBe('Last week')
    expect(ago(15)).toBe('2 weeks ago')
    expect(ago(60)).toBe('2 months ago')
    expect(ago(300)).toBe('10 months ago')
    expect(ago(400)).toBe('Last year')
    expect(ago(800)).toBe('2 years ago')
  })

  test('a date ahead of now, from a feed whose clock is wrong, is today', () => {
    expect(postedAgo(NOW + 3 * DAY, 'en', NOW)).toBe('Today')
  })

  test('in the other interface languages, capitalised where they have capitals', () => {
    expect(ago(15, 'fr')).toBe('Il y a 2 semaines')
    expect(ago(0.2, 'zh-Hans')).toBe('今天')
    expect(ago(60, 'zh-Hant')).toBe('2個月前')
  })
})

describe('compareBy', () => {
  const row = (title: string, latest: number | null, dead = false): Sortable => ({
    title,
    latest,
    dead,
  })
  const rows = [
    row('Atlas', NOW - 30 * DAY),
    row('beta', NOW - DAY),
    row('Dead', NOW - 2 * DAY, true),
    row('Empty', null),
  ]
  const order = (key: Parameters<typeof compareBy>[0]) =>
    [...rows].sort(compareBy(key)).map((r) => r.title)

  test('A to Z goes by base letters, whatever the case', () => {
    expect(order('name')).toEqual(['Atlas', 'beta', 'Dead', 'Empty'])
  })

  test('Recently posted puts the newest first and a blog with no date last', () => {
    expect(order('recent')).toEqual(['beta', 'Dead', 'Atlas', 'Empty'])
  })

  test('Quiet longest puts a feed that stopped first, then one with no post, then the oldest', () => {
    expect(order('quiet')).toEqual(['Dead', 'Empty', 'Atlas', 'beta'])
  })
})

describe('the filter', () => {
  test('ignores accents and case, in the name or the address', () => {
    const matches = matcher('  VELO ')
    expect(matches(['Vélo du Dimanche', 'velodudimanche.fr'])).toBe(true)
    expect(matcher('dimanche.fr')(['Something else', 'velodudimanche.fr'])).toBe(true)
    expect(matcher('rust')(['Vélo du Dimanche', 'velodudimanche.fr'])).toBe(false)
  })

  test('an empty filter asks for every blog, a missing field matches nothing', () => {
    expect(matcher('')([])).toBe(true)
    expect(matcher('x')([null, undefined])).toBe(false)
  })

  test('folds what the eye reads as one letter', () => {
    expect(fold('Ça Fait Été')).toBe('ca fait ete')
    expect(fold('京都散歩')).toBe('京都散歩')
  })
})

describe('ticks', () => {
  const shown = [10, 20, 30, 40]

  test('a click toggles a row and starts a run there', () => {
    const one = clickRow(NO_TICKS, shown, 20, false)
    expect([...one.picked]).toEqual([20])
    expect(one.anchor).toBe(20)
    expect([...clickRow(one, shown, 20, false).picked]).toEqual([])
  })

  test('Shift ticks every row shown from the last one clicked, either way', () => {
    const one = clickRow(NO_TICKS, shown, 40, false)
    const run = clickRow(one, shown, 20, true)
    expect([...run.picked].sort()).toEqual([20, 30, 40])
    expect(run.anchor).toBe(40)
  })

  test('Shift with no run start shown, after the filter changed, toggles as a click does', () => {
    const one = clickRow(NO_TICKS, [99], 99, false)
    const run = clickRow(one, shown, 30, true)
    expect([...run.picked].sort()).toEqual([30, 99])
    expect(run.anchor).toBe(30)
  })

  test('the box over them: none, some or all of the rows shown', () => {
    expect(tickedState(new Set(), shown)).toBe('none')
    expect(tickedState(new Set([10]), shown)).toBe('some')
    expect(tickedState(new Set(shown), shown)).toBe('all')
    expect(tickedState(new Set(), [])).toBe('none')
    // A tick the filter hides is still a tick.
    expect(tickedState(new Set([99]), shown)).toBe('some')
  })

  test('pressing the box clears what is ticked, or ticks every row shown', () => {
    expect([...toggleAll(new Set(), shown).picked]).toEqual(shown)
    expect(toggleAll(new Set([10]), shown).picked.size).toBe(0)
  })

  test('a blog no longer followed is no longer ticked, and hidden ticks are counted', () => {
    expect(standing(new Set([10, 20, 99]), new Set([10, 20, 30]))).toEqual([10, 20])
    expect(hiddenTicks([10, 99], shown)).toBe(1)
  })
})
