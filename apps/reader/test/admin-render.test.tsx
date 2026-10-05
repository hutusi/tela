/**
 * The admin console drawn on the server, from fixtures: the ledger with a fixture area (rows,
 * columns, the record beside them, the empty states) and the Overview from a fixture answer. No
 * effect runs in a server render, so nothing here asks tela-api anything.
 */
import { describe, expect, test } from 'bun:test'
import type { UiLocale } from '@tela/shared'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import type { AnyAreaSpec } from '../src/admin/area'
import { AdminContext } from '../src/admin/context'
import { AdminI18n } from '../src/admin/i18n'
import { Ledger } from '../src/admin/ledger/ledger'
import { OverviewView } from '../src/admin/overview'
import { UiContext } from '../src/ui'
import { BLOG_LIST, blogSpec, OVERVIEW, QUIET_ADMIN } from './admin-fixtures'

function render(node: React.ReactNode, path: string, locale: UiLocale = 'en'): string {
  return renderToString(
    <UiContext.Provider value={{ locale, setLocale() {} }}>
      <AdminI18n>
        <MemoryRouter initialEntries={[path]}>
          <AdminContext.Provider value={QUIET_ADMIN}>{node}</AdminContext.Provider>
        </MemoryRouter>
      </AdminI18n>
    </UiContext.Provider>,
  )
}

/** Where each of `words` first appears, to read the order rows were drawn in. */
const order = (html: string, words: string[]) =>
  [...words].sort((a, b) => html.indexOf(a) - html.indexOf(b))

const spec = blogSpec() as AnyAreaSpec

describe('the ledger', () => {
  test('draws the area, its filters with their counts, and every row', () => {
    const html = render(<Ledger area="sites" spec={spec} initial={BLOG_LIST} />, '/admin/sites')
    expect(html).toContain('Library')
    expect(html).toContain('Sites')
    expect(html).toContain('Every blog Tela knows')
    for (const label of ['In Discover', 'Private', 'Needs attention', 'Hidden']) {
      expect(html).toContain(label)
    }
    expect(html).toMatch(/aria-pressed="true"[^>]*data-filter="discover"/)
    expect(html).toContain('Search blogs by name or address')
    expect(html).toContain('3 in In Discover · click a column to sort')
    expect(html.match(/data-testid="admin-row"/g)).toHaveLength(3)
    // The name, the three columns, the status and the likeliest action, as the area says them.
    for (const text of ['Pfadwerk', 'pfadwerk.example', 'Readers', 'Language', '—', 'Listed']) {
      expect(html).toContain(text)
    }
    expect(html).toContain('data-action="site.feature"')
    expect(html).toContain('>Feature<')
    // Hide is the likeliest on Nordvest, and takes something away.
    expect(html).toMatch(
      /text-danger[^"]*"[^>]*data-testid="admin-row-action" data-action="site.hide"/,
    )
    // The first row has the keyboard until a key moves it.
    expect(html).toMatch(/data-row-id="7" data-focus="true"/)
    expect(html).toContain('J K')
    expect(html).not.toContain('data-testid="admin-record"')
    expect(html).not.toContain('data-testid="admin-bulk"')
  })

  test('sorts by the column the address names', () => {
    const desc = render(
      <Ledger area="sites" spec={spec} initial={BLOG_LIST} />,
      '/admin/sites?sort=c1&dir=desc',
    )
    expect(order(desc, ['Nordvest', 'Pfadwerk', '日々の海'])).toEqual([
      'Nordvest',
      'Pfadwerk',
      '日々の海',
    ])
    expect(desc).toContain('data-sort="desc"')
    expect(desc).toContain('Readers ↓')
    const asc = render(
      <Ledger area="sites" spec={spec} initial={BLOG_LIST} />,
      '/admin/sites?sort=c1',
    )
    expect(order(asc, ['Nordvest', 'Pfadwerk', '日々の海'])).toEqual([
      '日々の海',
      'Pfadwerk',
      'Nordvest',
    ])
  })

  test('an open record stands beside a narrower table, with its place and its actions', () => {
    const html = render(
      <Ledger area="sites" spec={spec} initial={BLOG_LIST} />,
      '/admin/sites?id=7',
    )
    expect(html).toContain('data-testid="admin-record"')
    expect(html).toContain('1 of 3')
    expect(html).toContain('data-record="7"')
    // The detail is on its way: a server render loads nothing.
    expect(html).toContain('the record is on its way')
    expect(html).toMatch(/data-row-id="7" data-focus="true" data-open="true"/)
    // The middle columns and the row's own action give way to the record.
    expect(html).not.toContain('>Readers<')
    expect(html).not.toContain('data-testid="admin-row-action"')
    // Its actions, with their keys: the first filled, Hide in danger, the fourth without a key.
    expect(html.match(/data-testid="admin-record-action"/g)).toHaveLength(4)
    expect(html).toContain('Hide from Discover')
    expect(html).toMatch(/bg-primary[^"]*"[^>]*data-action="site.feature">Feature<kbd[^>]*>1</)
    expect(html).toMatch(/data-action="site.translationOff">Pause translation<kbd[^>]*>3</)
    expect(html).toMatch(/data-action="site.fetchAll">Fetch all feeds<\/button>/)
    expect(html).toContain('← Back to the list')
  })

  test('an area may name an action in its own words', () => {
    const own = blogSpec({
      actionLabel: (_row, action) => (action === 'site.feature' ? 'Unfeature' : undefined),
    }) as AnyAreaSpec
    const html = render(<Ledger area="sites" spec={own} initial={BLOG_LIST} />, '/admin/sites')
    expect(html).toContain('>Unfeature<')
  })

  test('an area with no bulk action draws no check boxes', () => {
    const checks = render(<Ledger area="sites" spec={spec} initial={BLOG_LIST} />, '/admin/sites')
    expect(checks.match(/type="checkbox"/g)).toHaveLength(4)
    const none = blogSpec({ bulk: [] }) as AnyAreaSpec
    const html = render(<Ledger area="sites" spec={none} initial={BLOG_LIST} />, '/admin/sites')
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('28px_')
  })

  test('an empty queue is clear; an empty search has no matches; anything else is empty', () => {
    const empty = { ...BLOG_LIST, rows: [] }
    const queue = blogSpec({ queue: true }) as AnyAreaSpec
    expect(render(<Ledger area="sites" spec={queue} initial={empty} />, '/admin/sites')).toContain(
      'Queue clear.',
    )
    // Only the first filter is a queue.
    expect(
      render(<Ledger area="sites" spec={queue} initial={empty} />, '/admin/sites?f=hidden'),
    ).toContain('Nothing here.')
    const search = render(<Ledger area="sites" spec={spec} initial={empty} />, '/admin/sites?q=zzz')
    expect(search).toContain('No matches')
    expect(search).toContain('0 matches in In Discover')
    expect(render(<Ledger area="sites" spec={spec} initial={empty} />, '/admin/sites')).toContain(
      'Nothing in In Discover right now.',
    )
  })

  test('says when the list was cut short', () => {
    const html = render(
      <Ledger area="sites" spec={spec} initial={{ ...BLOG_LIST, truncated: true }} />,
      '/admin/sites',
    )
    expect(html).toContain('Showing the first 500. Search to narrow it.')
  })

  test('before an answer, it is loading', () => {
    const html = render(<Ledger area="sites" spec={spec} />, '/admin/sites')
    expect(html).toContain('Loading…')
    expect(html).not.toContain('data-testid="admin-row"')
  })

  test('reads in Simplified Chinese', () => {
    const html = render(
      <Ledger area="sites" spec={spec} initial={BLOG_LIST} />,
      '/admin/sites?id=12',
      'zh-Hans',
    )
    expect(html).toContain('内容库')
    expect(html).toContain('第 2 项，共 3 项')
    expect(html).toContain('从发现中隐藏')
    expect(html).toContain('← 返回列表')
  })

  test('French reads the console in English', () => {
    const html = render(
      <Ledger area="sites" spec={spec} initial={BLOG_LIST} />,
      '/admin/sites',
      'fr',
    )
    expect(html).toContain('3 in In Discover · click a column to sort')
  })
})

describe('the Overview', () => {
  const now = Date.UTC(2026, 9, 4, 14, 0)

  test('draws health, the queues, the week and the activity', () => {
    const html = render(
      <OverviewView overview={OVERVIEW} failed={false} onRetry={() => {}} now={now} />,
      '/admin',
    )
    expect(html).toContain('Overview')
    expect(html).toContain('October')
    expect(html).toContain('6 decisions waiting across four queues.')
    expect(html).toContain('data-ok="false"')
    expect(html).toContain('24 articles have waited over six hours for the full text')
    expect(html).toContain('System →')
    // In UTC, as System says it.
    expect(html).toContain('checked 13:05 UTC')
    // The four queues, each with its count and the way in.
    for (const label of [
      'Claims to review',
      'Failing feeds',
      'Dead letters',
      'Discover candidates',
    ]) {
      expect(html).toContain(label)
    }
    expect(html).toContain('href="/admin/feeds"')
    // A queue's filter is its area's first, which a plain address already opens.
    expect(html).toContain('href="/admin/system"')
    expect(html).toContain('href="/admin/discover?f=candidates"')
    // A claim on an untitled blog reads as its host, and opens in its queue.
    expect(html).toContain('pfadwerk.example')
    expect(html).toContain('@mara · No tela-verify tag on the home page')
    expect(html).toContain('href="/admin/claims?id=41"')
    expect(html).toContain('href="/admin/feeds?id=88"')
    expect(html).toContain('href="/admin/discover?f=candidates&amp;id=30"')
    expect(html).toContain('2 readers')
    expect(html).toContain('Nothing waiting.')
    // This week against the last.
    expect(html).toContain('>47<')
    expect(html).toContain('35 the week before')
    expect(html).toContain('1.3M')
    expect(html).toContain('980K the week before')
    // Recent activity: who, what, to what, and where it is acted on.
    expect(html).toContain('@hutusi')
    expect(html).toContain('Featured · Nordvest')
    expect(html).toContain('href="/admin/sites?id=12"')
    // A dead letter and a code open as their ledgers list them, not by the audit log's bare key.
    expect(html).toContain('href="/admin/system?id=dead%3A5"')
    expect(html).toContain('href="/admin/invites?id=code%3AWRITERS"')
    expect(html).toContain('The CLI')
    expect(html).toContain('Made an admin · @mara')
    expect(html).toContain('Undid: Paused')
  })

  test('a feed timing out opens under Timing out, not Failing', () => {
    const feed = OVERVIEW.queues.feeds.rows[0]!
    const slow = { ...feed, id: '89', feedId: 89, errorCount: 0, timeoutStreak: 4 }
    const mixed = {
      ...OVERVIEW,
      queues: { ...OVERVIEW.queues, feeds: { count: 2, rows: [feed, slow] } },
    }
    const html = render(
      <OverviewView overview={mixed} failed={false} onRetry={() => {}} now={now} />,
      '/admin',
    )
    expect(html).toContain('href="/admin/feeds?id=88"')
    expect(html).toContain('href="/admin/feeds?f=timeout&amp;id=89"')
    // Start opens Failing while any row is failing…
    expect(html).toContain('href="/admin/feeds"')
    // …and Timing out once every row is timing out.
    const slowOnly = {
      ...OVERVIEW,
      queues: { ...OVERVIEW.queues, feeds: { count: 1, rows: [slow] } },
    }
    const timeout = render(
      <OverviewView overview={slowOnly} failed={false} onRetry={() => {}} now={now} />,
      '/admin',
    )
    expect(timeout).toContain('href="/admin/feeds?f=timeout"')
    expect(timeout).not.toContain('href="/admin/feeds"')
  })

  test('a calm day says so', () => {
    const calm = {
      ...OVERVIEW,
      queues: {
        claims: { count: 0, rows: [] },
        feeds: { count: 0, rows: [] },
        dead: { count: 0, rows: [] },
        candidates: { count: 0, rows: [] },
      },
    }
    const html = render(
      <OverviewView overview={calm} failed={false} onRetry={() => {}} now={now} />,
      '/admin',
    )
    expect(html).toContain('Nothing waiting. Tela is running on its own.')
    expect(html.match(/Nothing waiting\.</g)).toHaveLength(4)
  })

  test('loading, and a failure with a way to try again', () => {
    const loading = render(
      <OverviewView overview={null} failed={false} onRetry={() => {}} now={now} />,
      '/admin',
    )
    expect(loading).toContain('Loading…')
    const failed = render(
      <OverviewView overview={null} failed onRetry={() => {}} now={now} />,
      '/admin',
    )
    expect(failed).toContain('Couldn&#x27;t load this.')
    expect(failed).toContain('Try again')
  })

  test('reads in Simplified Chinese', () => {
    const html = render(
      <OverviewView overview={OVERVIEW} failed={false} onRetry={() => {}} now={now} />,
      '/admin',
      'zh-Hans',
    )
    expect(html).toContain('四个队列中共有 6 项待处理。')
    expect(html).toContain('待你处理')
    expect(html).toContain('上周 35')
    expect(html).toContain('检查于 UTC 13:05')
    expect(html).toContain('已设为精选 · Nordvest')
  })
})
