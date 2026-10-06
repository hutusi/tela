/**
 * Fixtures for the admin console's tests: an area as a slice would give it, and an Overview as
 * tela-api would answer it. Test data only; nothing in src imports this.
 */
import type {
  AdminActionName,
  AdminClaimRow,
  AdminFeedRow,
  AdminList,
  AdminOverview,
  AdminRowBase,
  AdminSiteRow,
  AdminTone,
} from '@tela/shared/admin'
import type { AreaSpec } from '../src/admin/area'
import type { AdminContextValue } from '../src/admin/context'

export type BlogRow = AdminRowBase & {
  title: string
  host: string
  readers: number
  lang: string | null
  tone: AdminTone
}

export const BLOGS: BlogRow[] = [
  {
    id: '7',
    actions: ['site.feature', 'site.hide', 'site.translationOff', 'site.fetchAll'],
    title: 'Pfadwerk',
    host: 'pfadwerk.example',
    readers: 3,
    lang: 'de',
    tone: 'ok',
  },
  {
    id: '12',
    actions: ['site.hide'],
    title: 'Nordvest',
    host: 'nordvest.example',
    readers: 12,
    lang: null,
    tone: 'bad',
  },
  {
    id: '30',
    actions: [],
    title: '日々の海',
    host: 'hibi.example',
    readers: 0,
    lang: 'ja',
    tone: 'neutral',
  },
]

export const BLOG_LIST: AdminList<BlogRow, 'sites'> = {
  counts: { discover: 3, private: 9, attention: 0, hidden: 1 },
  rows: BLOGS,
  truncated: false,
}

const FILTERS = {
  discover: 'In Discover',
  private: 'Private',
  attention: 'Needs attention',
  hidden: 'Hidden',
} as const

/** A Sites ledger as the library slice might give it, with words already chosen. */
export function blogSpec(
  overrides: Partial<AreaSpec<'sites', BlogRow, { note: string }>> = {},
): AreaSpec<'sites', BlogRow, { note: string }> {
  return {
    area: 'sites',
    filterLabel: (filter) => FILTERS[filter],
    searchHint: 'Search blogs by name or address',
    load: async () => BLOG_LIST,
    loadDetail: async (id) => ({ note: `the record of ${id}` }),
    name: {
      label: 'Blog',
      title: (row) => row.title,
      sub: (row) => row.host,
      tile: (row) => <span data-tile={row.id}>{row.title.slice(0, 1)}</span>,
    },
    columns: [
      { label: 'Readers', text: (row) => String(row.readers), number: (row) => row.readers },
      { label: 'Language', text: (row) => row.lang ?? '—' },
      { label: 'Host', text: (row) => row.host },
    ],
    status: (row) => ({ tone: row.tone, label: row.tone === 'ok' ? 'Listed' : 'Failing' }),
    Record: ({ row, detail }) => (
      <div data-record={row.id}>{detail ? detail.note : 'the record is on its way'}</div>
    ),
    bulk: ['site.feature', 'site.hide'] as readonly AdminActionName[],
    ...overrides,
  }
}

/** A frame that does nothing: what the shell gives an area, minus the server. */
export const QUIET_ADMIN: AdminContextValue = {
  version: 0,
  changed() {},
  toast: null,
  say() {},
  dismiss() {},
  undo() {},
  deny() {},
  restored: null,
}

const person = (handle: string) => ({ id: `u-${handle}`, handle, name: null })

const claim: AdminClaimRow = {
  id: '41',
  actions: ['claim.recheck', 'claim.vouch', 'claim.reject'],
  claimId: 41,
  siteId: 7,
  siteTitle: null,
  homeUrl: 'https://www.pfadwerk.example/',
  faviconKey: null,
  claimant: person('mara'),
  owner: null,
  method: 'meta',
  status: 'failed',
  error: 'No tela-verify tag on the home page',
  vouched: false,
  createdAt: 1_759_000_000_000,
  lastCheckedAt: 1_759_600_000_000,
  verifiedAt: null,
  reviewedAt: null,
  attempts: 3,
  nextTry: null,
  readerCount: 2,
}

const feed: AdminFeedRow = {
  id: '88',
  actions: ['feed.fetch', 'feed.pause'],
  feedId: 88,
  siteId: 12,
  siteTitle: 'Nordvest',
  homeUrl: 'https://nordvest.example/',
  faviconKey: null,
  feedUrl: 'https://nordvest.example/feed.xml',
  format: 'rss',
  status: 'active',
  region: 'global',
  errorCount: 4,
  timeoutStreak: 0,
  lastError: 'HTTP 503',
  lastFetchedAt: 1_759_600_000_000,
  lastItemAt: null,
  nextFetchAt: 1_759_700_000_000,
  mergedInto: null,
  owner: null,
  readerCount: 5,
}

export const candidate: AdminSiteRow = {
  id: '30',
  actions: ['site.list', 'site.dismiss', 'site.feature', 'site.hide'],
  siteId: 30,
  title: '日々の海',
  homeUrl: 'https://hibi.example/',
  faviconKey: null,
  listing: 'private',
  owner: null,
  readerCount: 2,
  feedCount: 1,
  feedHealth: 'ok',
  claimFailing: false,
  primaryLang: 'ja',
  translationOptOut: false,
  topics: [],
  createdAt: 1_759_000_000_000,
  postsLast30d: 6,
  latestTitle: '港の朝',
  latestAt: 1_759_500_000_000,
  review: null,
  reviewedAt: null,
}

export const OVERVIEW: AdminOverview = {
  health: {
    ok: false,
    at: Date.UTC(2026, 9, 4, 13, 5),
    checks: [
      { name: 'overdueFeeds', value: 0, limit: 3, ok: true },
      { name: 'deadLetters', value: 1, limit: 20, ok: true },
      { name: 'stuckBodies', value: 0, limit: 0, ok: true },
      { name: 'extractionBacklog', value: 24, limit: 20, ok: false },
      { name: 'backupAge', value: 5, limit: 36, ok: true },
      { name: 'backupVerified', value: null, limit: null, ok: true },
    ],
  },
  queues: {
    claims: { count: 1, rows: [claim] },
    feeds: { count: 2, rows: [feed] },
    dead: { count: 0, rows: [] },
    candidates: { count: 3, rows: [candidate] },
  },
  week: {
    members: [47, 35],
    claimsVerified: [9, 6],
    feedsAdded: [63, 71],
    tokens: [1_250_000, 980_000],
  },
  activity: [
    {
      id: 3,
      at: 1_759_600_000_000,
      actor: person('hutusi'),
      action: 'site.feature',
      targetKind: 'site',
      targetKey: '12',
      label: 'Nordvest',
    },
    {
      id: 2,
      at: 1_759_500_000_000,
      actor: null,
      action: 'admin.grant',
      targetKind: 'member',
      targetKey: 'u-mara',
      label: '@mara',
    },
    {
      id: 5,
      at: 1_759_450_000_000,
      actor: person('hutusi'),
      action: 'dead.retry',
      targetKind: 'dead',
      targetKey: '5',
      label: 'feed.fetch 88',
    },
    {
      id: 4,
      at: 1_759_420_000_000,
      actor: person('hutusi'),
      action: 'code.revoke',
      targetKind: 'code',
      targetKey: 'WRITERS',
      label: 'WRITERS',
    },
    {
      id: 1,
      at: 1_759_400_000_000,
      actor: person('hutusi'),
      action: 'undo',
      undid: 'feed.pause',
      targetKind: 'feed',
      targetKey: '88',
      label: null,
    },
  ],
}
