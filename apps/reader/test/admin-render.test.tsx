/**
 * The admin console drawn on the server, from fixtures: the ledger with a fixture area (rows,
 * columns, the record beside them, the empty states) and the Overview from a fixture answer. No
 * effect runs in a server render, so nothing here asks tela-api anything.
 */
import { describe, expect, test } from 'bun:test'
import type { UiLocale } from '@tela/shared'
import type { AdminBlogrollRow, AdminList, AdminSiteRow } from '@tela/shared/admin'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import type { AnyAreaSpec } from '../src/admin/area'
import { type DiscoverRow, useDiscoverArea } from '../src/admin/areas/discover'
import { ActionPrompt } from '../src/admin/components/prompt'
import { AdminContext } from '../src/admin/context'
import { AdminI18n } from '../src/admin/i18n'
import { Ledger } from '../src/admin/ledger/ledger'
import { OverviewView } from '../src/admin/overview'
import { UiContext } from '../src/ui'
import { BLOG_LIST, blogroll, blogSpec, candidate, OVERVIEW, QUIET_ADMIN } from './admin-fixtures'

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
    // A table of rows and cells to a screen reader, each row's check named by its row.
    expect(html).toContain('role="table" aria-label="Sites"')
    expect(html.match(/role="row"/g)).toHaveLength(4)
    expect(html).toContain('aria-label="Select Pfadwerk"')
    expect(html).toContain('aria-label="Select all"')
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
    // The direction is said as well as drawn: on the column's header, and in the button's name,
    // which no aria-label hides.
    expect(desc).toMatch(/role="columnheader" aria-sort="descending"[^>]*><button/)
    expect(desc.match(/aria-sort=/g)).toHaveLength(1)
    expect(desc).not.toMatch(/<button[^>]*aria-label="Readers"/)
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
    // Nor does its key legend offer X.
    expect(html).not.toMatch(/<kbd[^>]*>X<\/kbd>/)
    expect(checks).toMatch(/<kbd[^>]*>X<\/kbd>/)
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

describe('Discover (ADR 0041)', () => {
  const listed: AdminSiteRow = {
    ...candidate,
    id: '31',
    siteId: 31,
    title: 'Pfadwerk',
    homeUrl: 'https://pfadwerk.example/',
    listing: 'listed',
    actions: ['site.feature', 'site.hide'],
    primaryLang: null,
    review: 'listed',
    reviewedAt: 1_759_400_000_000,
  }
  const LIST: AdminList<AdminSiteRow, 'discover'> = {
    counts: { candidates: 1, featured: 0, listed: 1, dismissed: 2, hidden: 0, blogrolls: 0 },
    rows: [candidate, listed],
    truncated: false,
  }
  function Discover() {
    return <Ledger area="discover" spec={useDiscoverArea()} initial={LIST} />
  }

  test('opens on the review queue, each blog with what a review needs and nobody who added it', () => {
    const html = render(<Discover />, '/admin/discover')
    expect(html).toMatch(/aria-pressed="true"[^>]*data-filter="candidates"/)
    expect(order(html, ['To review', 'Featured', 'Listed', 'Not for Discover', 'Hidden'])).toEqual([
      'To review',
      'Featured',
      'Listed',
      'Not for Discover',
      'Hidden',
    ])
    // The blog, its language and when it came; its latest post, its pace and its readers.
    expect(html).toContain('hibi.example · Japanese · added ')
    for (const text of ['Latest post', '港の朝', 'Posts, 30 days', '>6<', 'Readers']) {
      expect(html).toContain(text)
    }
    expect(html).toMatch(/data-row-id="30"[\s\S]*To review/)
    expect(html).toContain('data-action="site.list"')
    expect(html).toContain('>List<')
    // A listed blog with no topics says so: Discover files it only under All.
    expect(html).toContain('pfadwerk.example · no topics yet')
  })

  test('a blog to review offers List and Not for Discover first, and says what deciding does', () => {
    const html = render(<Discover />, '/admin/discover?id=30')
    expect(html).toMatch(/data-action="site.list">List in Discover<kbd[^>]*>1</)
    expect(html).toMatch(/data-action="site.dismiss">Not for Discover<kbd[^>]*>2</)
    expect(html).toContain('A member added this blog.')
    expect(html).toContain('never who')
    const zh = render(<Discover />, '/admin/discover?id=30', 'zh-Hans')
    expect(zh).toContain('待审核')
    expect(zh).toContain('不列入发现')
  })

  test('a listed blog with no topics is told so in its record', () => {
    const html = render(<Discover />, '/admin/discover?id=31')
    expect(html).toContain('No topics yet, so Discover shows this blog only under All.')
  })
})

describe('Discover’s blogrolls (ADR 0050)', () => {
  const hidden: AdminBlogrollRow = {
    ...blogroll,
    id: 'HiddenRoll01',
    blogrollId: 'HiddenRoll01',
    name: 'Kept out',
    hiddenAt: 1_759_600_000_000,
    inDiscover: false,
    actions: ['blogroll.restore'],
  }
  const few: AdminBlogrollRow = {
    ...blogroll,
    id: 'FewBlogs0001',
    blogrollId: 'FewBlogs0001',
    name: 'Just started',
    owner: { id: 'u-kim', handle: 'kim', name: null },
    blogCount: 2,
    totalCount: 2,
    inDiscover: false,
    blogs: [],
  }
  const ROLLS: AdminList<AdminBlogrollRow, 'discover'> = {
    counts: { candidates: 1, featured: 0, listed: 1, dismissed: 2, hidden: 0, blogrolls: 3 },
    rows: [blogroll, hidden, few],
    truncated: false,
  }
  function Blogrolls({ rows }: { rows: AdminList<DiscoverRow, 'discover'> }) {
    return <Ledger area="discover" spec={useDiscoverArea()} initial={rows} />
  }
  /** A status pill: its tone's dot, then its words. */
  const pill = (tone: string, label: string) =>
    new RegExp(
      `data-tone="${tone}"><span aria-hidden="true"[^>]*></span><span class="truncate">${label}<`,
    )

  test('lists each blogroll with its owner, its blogs, when it went public and where it stands', () => {
    const html = render(<Blogrolls rows={ROLLS} />, '/admin/discover?f=blogrolls')
    expect(html).toMatch(/aria-pressed="true"[^>]*data-filter="blogrolls"/)
    expect(html).toContain('Search blogrolls or owners')
    for (const text of ['Blogroll', 'Includes', 'Blogs', 'Public since']) {
      expect(html).toContain(`>${text}<`)
    }
    expect(html).not.toContain('>Latest post<')
    // Its name and owner, its first blogs (a blog with no title by its address), and how many
    // others see of the blogs put in.
    expect(html).toContain('Essays I return to')
    expect(html).toContain('Mara, @mara')
    expect(html).toContain('Nordvest, hibi.example')
    expect(html).toContain('3 of 4')
    expect(html).toContain('@kim')
    // In Discover is good news, Hidden the veto, and short of blogs simply waits.
    expect(html).toMatch(pill('ok', 'In Discover'))
    expect(html).toMatch(pill('bad', 'Hidden'))
    expect(html).toMatch(pill('neutral', 'Fewer than 3 blogs'))
    // Hide takes something away, as a blog's does; Restore does not.
    expect(html).toMatch(
      /text-danger[^"]*"[^>]*data-testid="admin-row-action" data-action="blogroll.hide"/,
    )
    expect(html).not.toMatch(
      /text-danger[^"]*"[^>]*data-testid="admin-row-action" data-action="blogroll.restore"/,
    )
    expect(html).toContain('data-action="blogroll.restore"')
    expect(html).toContain('>Hide<')
    expect(html).toContain('>Restore<')
  })

  test('a record says what a Hide leaves, with its actions', () => {
    const html = render(<Blogrolls rows={ROLLS} />, '/admin/discover?f=blogrolls&id=AbCdEf012345')
    expect(html).toContain('data-testid="admin-blogroll-record"')
    expect(html).toContain('Hidden blogrolls keep their page and their place on the profile.')
    expect(html).toContain('Long reads, slowly.')
    expect(html).toMatch(/data-action="blogroll.hide">Hide from Discover<kbd[^>]*>1</)
    const zh = render(
      <Blogrolls rows={ROLLS} />,
      '/admin/discover?f=blogrolls&id=HiddenRoll01',
      'zh-Hans',
    )
    expect(zh).toContain('博客链')
    expect(zh).toContain('被隐藏的博客链仍保留自己的页面')
    expect(zh).toMatch(/data-action="blogroll.restore">恢复到发现<kbd/)
  })

  test('rows of the other kind under a filter are drawn as what they are, never a crash', () => {
    // A blogroll's row under a blog filter, and a blog's under Blogrolls: for a moment the
    // address and the rows on screen can disagree.
    const mixed: AdminList<DiscoverRow, 'discover'> = { ...ROLLS, rows: [candidate, blogroll] }
    for (const path of [
      '/admin/discover',
      '/admin/discover?f=blogrolls',
      '/admin/discover?id=AbCdEf012345',
      '/admin/discover?f=blogrolls&id=30',
    ]) {
      const html = render(<Blogrolls rows={mixed} />, path)
      expect(html).toContain('日々の海')
      expect(html).toContain('Essays I return to')
    }
  })
})

describe('a confirmation', () => {
  test('asks in the plural for several, and its yes is described by what it does', () => {
    const html = render(
      <ActionPrompt
        prompt={{ action: 'code.revoke', ids: ['code:A', 'code:B'], where: 'bulk' }}
        busy={false}
        onAnswer={() => {}}
        onCancel={() => {}}
      />,
      '/admin/invites',
    )
    expect(html).toContain('Revoke these 2 codes?')
    const id = html.match(/<p id="([^"]+)"/)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`aria-describedby="${id}"`)
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
    for (const label of ['Claims to review', 'Failing feeds', 'Dead letters', 'Blogs to review']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('href="/admin/feeds"')
    // A queue's filter is its area's first, which a plain address already opens.
    expect(html).toContain('href="/admin/system"')
    // To review is Discover's first filter (ADR 0041), so its card opens the area as it is.
    expect(html).toContain('href="/admin/discover"')
    // A claim on an untitled blog reads as its host, and opens in its queue.
    expect(html).toContain('pfadwerk.example')
    expect(html).toContain('@mara · No tela-verify tag on the home page')
    expect(html).toContain('href="/admin/claims?id=41"')
    expect(html).toContain('href="/admin/feeds?id=88"')
    expect(html).toContain('href="/admin/discover?id=30"')
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
