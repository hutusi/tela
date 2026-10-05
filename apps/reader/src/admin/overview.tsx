/**
 * The Overview (the design's start page): the health check in one line, what needs an operator in
 * four queues, this week against the last, and what operators did lately. Read from tela-api
 * (`/api/v1/admin/overview`); every row links into the ledger that acts on it.
 */
import type {
  AdminClaimRow,
  AdminDeadRow,
  AdminFeedRow,
  AdminFilter,
  AdminHealth,
  AdminOverview,
  AdminRowBase,
  AdminSiteRow,
  AdminTone,
  LedgerArea,
} from '@tela/shared/admin'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { useLocale, useTranslations } from 'use-intl'
import { displayHost, relativeTime, shortDate } from '../lib/format'
import { useLive } from '../lib/use-live'
import { historyWords, type Translate } from './act'
import { adminGet, NotAdmin } from './api'
import type { AnyAreaSpec, Status } from './area'
import { AREA_HOOKS } from './areas'
import { ActionButton } from './components/buttons'
import { Dot, StatusPill } from './components/record'
import { useAdmin } from './context'
import { ledgerHref } from './state'

const loadOverview = (signal?: AbortSignal) => adminGet<AdminOverview>('overview', signal)

export function Overview() {
  const { version, deny } = useAdmin()
  const { value, failed, error, reload } = useLive(loadOverview)
  useEffect(() => {
    if (error instanceof NotAdmin) deny()
  }, [error, deny])
  // An undo from the toast changes what waits. The version the page opened at is already loaded.
  const seen = useRef(version)
  useEffect(() => {
    if (version === seen.current) return
    seen.current = version
    void reload()
  }, [version, reload])
  return <OverviewView overview={value} failed={failed} onRetry={() => void reload()} />
}

/** What a queue card shows of a row, and which ledger acts on it. */
type QueueRow = { id: string; title: string; sub: string; status: Status }

type Queue = {
  key: keyof AdminOverview['queues']
  area: LedgerArea
  filter: AdminFilter
  count: number
  rows: QueueRow[]
}

/** Where an audit entry's target is acted on, by its kind. */
const TARGET_AREA: Record<string, LedgerArea> = {
  site: 'sites',
  feed: 'feeds',
  claim: 'claims',
  member: 'people',
  code: 'invites',
  hold: 'invites',
  dead: 'system',
  lease: 'system',
}

/** A status for a row whose area has not said: the dot alone carries it, in the tone's word. */
function fallbackStatus(t: Translate, tone: AdminTone): Status {
  return { tone, label: t(`tones.${tone}`) }
}

/** The page itself, from an answer: the tests render it with a fixture. */
export function OverviewView({
  overview,
  failed,
  onRetry,
  now = Date.now(),
}: {
  overview: AdminOverview | null
  failed: boolean
  onRetry: () => void
  now?: number
}) {
  const t = useTranslations('admin.shell')
  const locale = useLocale()
  // Each queue's own area says what its rows' states are called, where it has been built.
  const claims = AREA_HOOKS.claims()
  const feeds = AREA_HOOKS.feeds()
  const system = AREA_HOOKS.system()
  const discover = AREA_HOOKS.discover()
  const statusOf = (spec: AnyAreaSpec | null, row: AdminRowBase, tone: AdminTone) =>
    spec ? spec.status(row) : fallbackStatus(t, tone)

  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(now))

  const head = (
    <div className="flex flex-col gap-1.5">
      <div className="text-[11px] font-semibold tracking-[.1em] text-accent uppercase">{date}</div>
      <h1 className="m-0 font-serif text-[34px] leading-[1.05] font-medium tracking-[-0.015em] md:text-[40px]">
        {t('nav.overview')}
      </h1>
      {overview ? (
        <p className="m-0 text-[15px] text-ink-2" data-testid="admin-waiting">
          {waiting(overview) > 0
            ? t('overview.waiting', { n: waiting(overview) })
            : t('overview.calm')}
        </p>
      ) : null}
    </div>
  )

  if (!overview) {
    return (
      <div className="flex flex-col gap-6 pb-10" data-testid="admin-overview">
        {head}
        {failed ? (
          <div className="flex flex-wrap items-center gap-3 text-ink-2">
            {t('ledger.loadFailed')}
            <ActionButton look="ghost" onClick={onRetry}>
              {t('ledger.retry')}
            </ActionButton>
          </div>
        ) : (
          <p className="m-0 text-muted">{t('ledger.loading')}</p>
        )}
      </div>
    )
  }

  const { queues } = overview
  const cards: Queue[] = [
    {
      key: 'claims',
      area: 'claims',
      filter: 'review',
      count: queues.claims.count,
      rows: queues.claims.rows.map((row: AdminClaimRow) => ({
        id: row.id,
        title: row.siteTitle ?? displayHost(row.homeUrl),
        sub:
          [row.claimant ? `@${row.claimant.handle}` : null, row.error]
            .filter(Boolean)
            .join(' · ') || displayHost(row.homeUrl),
        status: statusOf(claims, row, row.status === 'failed' ? 'bad' : 'info'),
      })),
    },
    {
      key: 'feeds',
      area: 'feeds',
      filter: 'failing',
      count: queues.feeds.count,
      rows: queues.feeds.rows.map((row: AdminFeedRow) => ({
        id: row.id,
        title: row.siteTitle ?? row.feedUrl,
        sub: row.lastError ?? displayHost(row.feedUrl),
        status: statusOf(feeds, row, row.timeoutStreak >= 3 ? 'warn' : 'bad'),
      })),
    },
    {
      key: 'dead',
      area: 'system',
      filter: 'dead',
      count: queues.dead.count,
      rows: queues.dead.rows.map((row: AdminDeadRow) => ({
        id: row.id,
        title: `${row.kind} · ${row.key}`,
        sub: row.error ?? row.target?.label ?? '',
        status: statusOf(system, row, 'bad'),
      })),
    },
    {
      key: 'candidates',
      area: 'discover',
      filter: 'candidates',
      count: queues.candidates.count,
      rows: queues.candidates.rows.map((row: AdminSiteRow) => ({
        id: row.id,
        title: row.title ?? displayHost(row.homeUrl),
        sub: `${displayHost(row.homeUrl)} · ${t('overview.readers', { n: row.readerCount })}`,
        status: statusOf(discover, row, 'neutral'),
      })),
    },
  ]

  return (
    <div className="flex flex-col pb-10" data-testid="admin-overview">
      {head}
      <HealthLine health={overview.health} />
      <h2 className="mt-7 mb-0 font-serif text-[26px] font-medium">{t('overview.needsYou')}</h2>
      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {cards.map((card) => (
          <QueueCard key={card.key} card={card} />
        ))}
      </div>
      <div className="mt-7 grid grid-cols-1 items-start gap-x-4 gap-y-7 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <Week week={overview.week} />
        <Activity activity={overview.activity} now={now} />
      </div>
    </div>
  )
}

/** Decisions waiting across the four queues. */
function waiting(overview: AdminOverview): number {
  const { claims, feeds, dead, candidates } = overview.queues
  return claims.count + feeds.count + dead.count + candidates.count
}

/** The health check in a sentence: what fails, or that nothing does. */
export function healthSummary(t: Translate, health: AdminHealth, locale: string): string {
  const failing = health.checks.filter((check) => !check.ok)
  if (failing.length === 0) return t('health.allOk')
  const sentences = failing.map((check) =>
    t(`health.${check.name}`, { value: check.value ?? 0, limit: check.limit ?? 0 }),
  )
  if (failing.length < health.checks.length) sentences.push(t('health.restOk'))
  // Chinese sentences end in their own full stop and need no space between them.
  return sentences.join(locale.startsWith('zh') ? '' : ' ')
}

function HealthLine({ health }: { health: AdminHealth }) {
  const t = useTranslations('admin.shell')
  const locale = useLocale()
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(health.at),
  )
  return (
    <Link
      to={ledgerHref('system')}
      className="mt-[22px] flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-line px-[18px] py-3 text-ink hover:border-muted hover:no-underline"
      data-testid="admin-health"
      data-ok={health.ok ? 'true' : 'false'}
    >
      <Dot tone={health.ok ? 'ok' : 'bad'} />
      <span className="shrink-0 font-semibold">{t('health.label')}</span>
      <span className="min-w-0 flex-[1_1_240px] text-ink-2">
        {healthSummary(t, health, locale)}
      </span>
      <span className="shrink-0 text-[12.5px] whitespace-nowrap text-muted">
        {t('health.checked', { time })}
      </span>
      <span className="shrink-0 font-semibold whitespace-nowrap text-accent">
        {t('health.system')}
      </span>
    </Link>
  )
}

function QueueCard({ card }: { card: Queue }) {
  const t = useTranslations('admin.shell')
  const at = (id?: string) => ledgerHref(card.area, { filter: card.filter, ...(id ? { id } : {}) })
  return (
    <section
      className="flex min-w-0 flex-col rounded-[14px] border border-line bg-surface px-[22px] pt-[18px] pb-2.5"
      data-testid="admin-queue"
      data-queue={card.key}
    >
      <div className="mb-2 flex items-baseline gap-2.5">
        <h3 className="m-0 min-w-0 truncate font-serif text-[24px] font-medium">
          {t(`overview.queues.${card.key}`)}
        </h3>
        <span className="shrink-0 text-[13px] text-muted tabular-nums">{card.count}</span>
        <div className="flex-1" />
        <Link
          to={at()}
          className="shrink-0 font-semibold whitespace-nowrap text-accent hover:underline"
        >
          {t('overview.start')}
        </Link>
      </div>
      {card.rows.slice(0, 3).map((row) => (
        <Link
          key={row.id}
          to={at(row.id)}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3.5 border-t border-line py-[11px] text-ink hover:text-accent hover:no-underline"
        >
          <div className="min-w-0">
            <div className="truncate font-medium">{row.title}</div>
            <div className="truncate text-[12.5px] text-muted">{row.sub}</div>
          </div>
          <StatusPill tone={row.status.tone} label={row.status.label} />
        </Link>
      ))}
      {card.rows.length === 0 ? (
        <div className="border-t border-line py-3 text-muted">{t('overview.nothingWaiting')}</div>
      ) : null}
    </section>
  )
}

function Week({ week }: { week: AdminOverview['week'] }) {
  const t = useTranslations('admin.shell')
  const locale = useLocale()
  const plain = new Intl.NumberFormat(locale)
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const cells = [
    ['members', week.members, plain],
    ['claimsVerified', week.claimsVerified, plain],
    ['feedsAdded', week.feedsAdded, plain],
    ['tokens', week.tokens, compact],
  ] as const
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="m-0 font-serif text-[26px] font-medium">{t('overview.thisWeek')}</h2>
      <div className="grid grid-cols-2 rounded-xl border border-line">
        {cells.map(([key, [now, before], format], i) => (
          <div
            key={key}
            className={`flex min-w-0 flex-col gap-0.5 px-[18px] py-3.5 ${i % 2 ? 'border-l border-line' : ''} ${i > 1 ? 'border-t border-line' : ''}`}
            data-testid="admin-week"
            data-week={key}
          >
            <span className="truncate text-[12.5px] text-muted">{t(`overview.week.${key}`)}</span>
            <span className="font-serif text-[30px] leading-[1.1] tabular-nums">
              {format.format(now)}
            </span>
            <span className="truncate text-[12.5px] text-ink-2">
              {t('overview.weekBefore', { n: format.format(before) })}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function Activity({ activity, now }: { activity: AdminOverview['activity']; now: number }) {
  const t = useTranslations('admin.shell')
  const locale = useLocale()
  // "2h ago" within the day, then the day itself, short enough for the column.
  const when = (at: number) =>
    now - at < 86_400_000 ? relativeTime(at, locale, now) : shortDate(at, locale, now)
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="m-0 font-serif text-[26px] font-medium">{t('overview.activity')}</h2>
      <div className="flex flex-col border-t border-line">
        {activity.length === 0 ? (
          <p className="m-0 border-b border-line py-2.5 text-[13.5px] text-muted">
            {t('overview.noActivity')}
          </p>
        ) : null}
        {activity.map((entry) => {
          const words = historyWords(t, entry)
          const line = entry.label ? t('toast.one', { action: words, target: entry.label }) : words
          const area: LedgerArea | undefined = TARGET_AREA[entry.targetKind]
          const body = (
            <>
              <span className="text-[12.5px] whitespace-nowrap text-muted">{when(entry.at)}</span>
              <span className="min-w-0 leading-[1.45] [overflow-wrap:anywhere]">
                <span className="font-semibold">
                  {entry.actor ? `@${entry.actor.handle}` : t('overview.cli')}
                </span>{' '}
                <span className="text-ink-2">{line}</span>
              </span>
            </>
          )
          const row =
            'grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-3.5 border-b border-line py-[9px] text-[13.5px] text-ink'
          return area ? (
            <Link
              key={entry.id}
              to={ledgerHref(area, { id: entry.targetKey })}
              className={`${row} hover:text-accent hover:no-underline`}
              data-testid="admin-activity"
            >
              {body}
            </Link>
          ) : (
            <div key={entry.id} className={row} data-testid="admin-activity">
              {body}
            </div>
          )
        })}
      </div>
    </section>
  )
}
