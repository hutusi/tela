/**
 * The Sites ledger (ADR 0039): every blog Tela knows, in one record with its feeds, owner,
 * listing, readers and translation. The queues link here. The pieces the other library areas
 * share (a blog's tile and name, a member's, a link to another record) live here too.
 */
import {
  type AdminClaimRow,
  type AdminFeedRow,
  type AdminFilter,
  type AdminPerson,
  type AdminSiteDetail,
  type AdminSiteRow,
  CLAIM_REMOVED_ERROR,
} from '@tela/shared/admin'
import { useMemo } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { SiteAvatar } from '../../components/site-avatar'
import { displayHost } from '../../lib/format'
import { nameIn } from '../../lib/language-name'
import { adminGet, adminList } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps, Status } from '../area'
import { History, KeyValues, Note, Section, StatusPill, useWhen } from '../components/record'

export type Translate = ReturnType<typeof useTranslations>

/** A blog's name: its title, or its address when it has none. */
export const blogName = (title: string | null, homeUrl: string) => title || displayHost(homeUrl)

/** The square a library row starts with: the blog's favicon, or its coloured initial. */
export function BlogTile({
  siteId,
  title,
  homeUrl,
  faviconKey,
}: {
  siteId: number
  title: string | null
  homeUrl: string
  faviconKey: string | null
}) {
  return (
    <SiteAvatar
      id={siteId}
      title={blogName(title, homeUrl)}
      faviconKey={faviconKey}
      size={28}
      radius={7}
    />
  )
}

/** "Kim Ji-woo, @jiwoo", or the handle alone. */
export const personName = (t: Translate, person: AdminPerson) =>
  person.name ? t('person', { name: person.name, handle: person.handle }) : handleOf(t, person)

export const handleOf = (t: Translate, person: AdminPerson | null) =>
  person ? t('handle', { handle: person.handle }) : t('none')

/** Words that open another record: a claim's blog, a blog's owner. */
export function RecordLink({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer text-left text-ink underline decoration-thumb underline-offset-2 hover:decoration-ink"
    >
      {children}
    </button>
  )
}

/** A number as the console's language writes it. */
export const count = (n: number, locale: string) => new Intl.NumberFormat(locale).format(n)

/** A language's name, or that it is not known. */
export const languageOf = (t: Translate, tag: string | null, locale: string) =>
  tag ? nameIn(tag, locale) : t('unknownLanguage')

/** A listing in words; a private blog nobody claimed is "Unclaimed" where that is the point. */
export function listingWords(t: Translate, row: AdminSiteRow, unclaimed = false): string {
  if (unclaimed && row.listing === 'private' && row.owner === null) return t('listing.unclaimed')
  return t(`listing.${row.listing}`)
}

/** A listing's dot: featured is good news, hidden a veto, the rest plain. */
export function listingStatus(t: Translate, row: AdminSiteRow, unclaimed = false): Status {
  const tone = row.listing === 'featured' ? 'ok' : row.listing === 'rejected' ? 'bad' : 'neutral'
  return { tone, label: listingWords(t, row, unclaimed) }
}

/** Restore reads as what it does to this blog: it unfeatures one, and un-hides another. */
export function restoreLabel(t: Translate, row: AdminSiteRow, action: string) {
  if (action !== 'site.restore') return undefined
  if (row.listing === 'featured') return t('actions.unfeature')
  if (row.listing === 'rejected') return t('actions.restoreDefault')
  return undefined
}

/** A blog's topics in words, in Discover's order. */
export const topicWords = (t: Translate, topics: readonly string[]) =>
  topics.map((topic) => t(`topics.${topic}`)).join(t('listSeparator'))

/** The short name of what went wrong with a feed, from its stored error (`kind: message`). */
export function feedErrorLabel(t: Translate, lastError: string | null): string {
  if (!lastError) return t('feedErrors.other')
  const kind = lastError.split(':')[0]?.trim() ?? ''
  const status = /^http_(\d{3})$/.exec(kind)?.[1]
  if (status === '404') return t('feedErrors.notFound')
  if (status === '410') return t('feedErrors.gone')
  if (status === '429' || status === '503') return t('feedErrors.rateLimited')
  if (status) return t('feedErrors.http', { status })
  if (kind === 'parse') return t('feedErrors.parse')
  if (kind === 'timeout') return t('feedErrors.timeout')
  if (kind === 'too_large') return t('feedErrors.tooLarge')
  if (kind === 'redirect_loop') return t('feedErrors.redirects')
  if (kind === 'blocked') return t('feedErrors.blocked')
  if (kind === 'network') {
    if (/CERT|TLS|SSL/i.test(lastError)) return t('feedErrors.tls')
    if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(lastError)) return t('feedErrors.dns')
    return t('feedErrors.network')
  }
  return t('feedErrors.other')
}

/**
 * A feed's state as a status: merged, dead and paused say so; an active one is timing out, failing
 * with the kind of error it last had, or healthy.
 */
export function feedStatus(t: Translate, feed: AdminFeedRow): Status {
  if (feed.mergedInto !== null) return { tone: 'neutral', label: t('feedStatus.merged') }
  if (feed.status === 'dead') return { tone: 'bad', label: t('feedStatus.dead') }
  if (feed.status === 'paused') return { tone: 'neutral', label: t('feedStatus.paused') }
  if (feed.timeoutStreak >= 3) return { tone: 'warn', label: t('feedStatus.timeout') }
  if (feed.errorCount > 0) return { tone: 'bad', label: feedErrorLabel(t, feed.lastError) }
  return { tone: 'ok', label: t('feedStatus.ok') }
}

/** A failed claim no operator has decided on since it last failed. */
export const inReview = (claim: AdminClaimRow) =>
  claim.status === 'failed' &&
  (claim.reviewedAt === null ||
    (claim.lastCheckedAt !== null && claim.reviewedAt < claim.lastCheckedAt))

/**
 * A claim's state. In the review queue: disputed when someone else owns the blog, needing review
 * when even a vouch did not settle it, and otherwise a check that failed. Out of it, removed or
 * reviewed.
 */
export function claimStatus(t: Translate, claim: AdminClaimRow): Status {
  if (claim.status === 'verified') return { tone: 'ok', label: t('claimStatus.verified') }
  if (claim.status === 'pending') return { tone: 'info', label: t('claimStatus.checking') }
  if (!inReview(claim)) {
    const removed = claim.error === CLAIM_REMOVED_ERROR
    return { tone: 'neutral', label: t(removed ? 'claimStatus.removed' : 'claimStatus.reviewed') }
  }
  if (claim.owner) return { tone: 'warn', label: t('claimStatus.disputed') }
  if (claim.vouched) return { tone: 'warn', label: t('claimStatus.review') }
  return { tone: 'bad', label: t('claimStatus.failed') }
}

/** A feed's address as a row names it: no scheme, no `www.`. */
export const feedAddress = (url: string) => url.replace(/^[a-z]+:\/\/(www\.)?/i, '')

// ---------------------------------------------------------------------------------------------

/** A blog's state: a feed in trouble first, then a claim to review, then its listing. */
function siteStatus(t: Translate, row: AdminSiteRow): Status {
  if (row.feedHealth === 'dead') return { tone: 'bad', label: t('siteStatus.dead') }
  if (row.feedHealth === 'failing') return { tone: 'bad', label: t('siteStatus.failing') }
  if (row.feedHealth === 'timeout') return { tone: 'warn', label: t('siteStatus.timeout') }
  if (row.claimFailing) return { tone: 'warn', label: t('siteStatus.claim') }
  return listingStatus(t, row)
}

const loadSites = (filter: AdminFilter<'sites'>, q: string, signal?: AbortSignal) =>
  adminList<AdminSiteRow, 'sites'>('sites', filter, q, signal)

/** A blog's record, for Sites and Discover alike (`GET /sites/:id`). */
export const loadSite = (id: string, signal?: AbortSignal) =>
  adminGet<AdminSiteDetail>(`sites/${encodeURIComponent(id)}`, signal)

function sitesSpec(t: Translate, locale: string): AreaSpec<'sites', AdminSiteRow, AdminSiteDetail> {
  return {
    area: 'sites',
    filterLabel: (filter) => t(`filters.sites.${filter}`),
    searchHint: t('search.sites'),
    load: loadSites,
    loadDetail: loadSite,
    rowOf: (detail) => detail.site,
    name: {
      label: t('names.site'),
      title: (row) => blogName(row.title, row.homeUrl),
      sub: (row) => displayHost(row.homeUrl),
      tile: (row) => <BlogTile {...row} />,
    },
    columns: [
      {
        label: t('columns.owner'),
        text: (row) => (row.owner ? handleOf(t, row.owner) : t('listing.unclaimed')),
      },
      {
        label: t('columns.feeds'),
        text: (row) =>
          t('feedCount', {
            n: count(row.feedCount, locale),
            health: t(`health.${row.feedHealth}`),
          }),
        number: (row) => row.feedCount,
      },
      {
        label: t('columns.readers'),
        text: (row) => count(row.readerCount, locale),
        number: (row) => row.readerCount,
      },
    ],
    status: (row) => siteStatus(t, row),
    Record: SiteRecord,
    bulk: ['site.fetchAll', 'site.hide'],
    actionLabel: (row, action) => restoreLabel(t, row, action),
  }
}

export function useSitesArea(): AnyAreaSpec {
  const t = useTranslations('admin.library')
  const locale = useLocale()
  return useMemo(() => sitesSpec(t, locale), [t, locale])
}

/** The history's words for a library action where the bare past tense says too little. */
export function useDescribe() {
  const t = useTranslations('admin.library')
  const shell = useTranslations('admin.shell')
  return (entry: { action: string; to?: unknown }) => {
    const to = (entry.to ?? null) as { error?: unknown } | unknown[] | null
    if (entry.action === 'site.topics' && Array.isArray(to)) {
      const topics = to.filter((x): x is string => typeof x === 'string')
      return `${shell('actions.site.topics.done')}: ${topics.length ? topicWords(t, topics) : t('none')}`
    }
    if (
      entry.action === 'claim.reject' &&
      to &&
      !Array.isArray(to) &&
      typeof to.error === 'string'
    ) {
      return `${shell('actions.claim.reject.done')}: “${to.error}”`
    }
    return undefined
  }
}

function SiteRecord({ row, detail, act, open }: RecordProps<AdminSiteRow, AdminSiteDetail>) {
  const t = useTranslations('admin.library')
  const shell = useTranslations('admin.shell')
  const locale = useLocale()
  const when = useWhen()
  const describe = useDescribe()
  const site = detail?.site ?? row
  const who = site.owner
  // How the owner proved it: their verified claim, when the record has loaded it.
  const proof = detail?.claims.find((c) => c.status === 'verified' && c.claimant?.id === who?.id)
  const owner = who ? (
    <RecordLink onClick={() => open('people', who.id)}>
      {proof
        ? t('kv.ownerValue', {
            person: personName(t, who),
            method: t(`methods.${proof.method}`),
            when: when(detail?.claimedAt ?? proof.verifiedAt),
          })
        : personName(t, who)}
    </RecordLink>
  ) : (
    t('listing.unclaimed')
  )
  const translation = (
    <span className="flex flex-wrap items-baseline gap-x-3">
      {site.translationOptOut ? t('kv.translationOff') : t('kv.translationOn')}
      <RecordLink
        onClick={() =>
          act(site.translationOptOut ? 'site.translationOn' : 'site.translationOff', [row.id])
        }
      >
        {shell(
          site.translationOptOut
            ? 'actions.site.translationOn.label'
            : 'actions.site.translationOff.label',
        )}
      </RecordLink>
    </span>
  )
  return (
    <div className="flex flex-col gap-5">
      <KeyValues
        rows={[
          [t('kv.owner'), owner],
          [
            t('kv.listing'),
            site.topics.length
              ? t('kv.listingValue', {
                  listing: listingWords(t, site),
                  topics: topicWords(t, site.topics),
                })
              : listingWords(t, site),
          ],
          [t('kv.readers'), count(site.readerCount, locale)],
          [t('kv.language'), languageOf(t, site.primaryLang, locale)],
          [t('kv.translation'), translation],
          [t('kv.tokens'), detail ? count(detail.tokens30d, locale) : null],
          [t('kv.added'), when(site.createdAt)],
          [t('kv.about'), detail?.description ?? null],
        ]}
      />
      {detail && detail.feeds.length > 0 ? (
        <Section label={t('sections.feeds')}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13.5px]">
            {detail.feeds.map((feed) => {
              const state = feedStatus(t, feed)
              return (
                <li key={feed.id} className="flex min-w-0 items-center justify-between gap-3">
                  <RecordLink onClick={() => open('feeds', feed.id)}>
                    <span className="[overflow-wrap:anywhere]">{feedAddress(feed.feedUrl)}</span>
                  </RecordLink>
                  <StatusPill tone={state.tone} label={state.label} />
                </li>
              )
            })}
          </ul>
        </Section>
      ) : null}
      {detail && detail.claims.length > 0 ? (
        <Section label={t('sections.claims')}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13.5px]">
            {detail.claims.map((claim) => (
              <li key={claim.id}>
                <RecordLink onClick={() => open('claims', claim.id)}>
                  {t('claimLine', {
                    who: handleOf(t, claim.claimant),
                    status: claimStatus(t, claim).label,
                  })}
                </RecordLink>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {row.listing === 'listed' || row.listing === 'featured' ? (
        <Note>{t('notes.discoverLag')}</Note>
      ) : null}
      {detail ? <History entries={detail.history} describe={describe} /> : null}
    </div>
  )
}
