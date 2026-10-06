/**
 * The Discover ledger (ADR 0039): what the public directory shows, and the blogs members added
 * that wait for an operator's review (ADR 0041), where it opens. Featuring is an editor's call;
 * hiding is the veto that sticks (ADR 0018); Not for Discover takes a blog out of the queue and
 * leaves the community door open. A record's topic chips set where Discover files the blog. A
 * row shows the blog, never who added it.
 */
import { TOPICS } from '@tela/shared'
import type {
  AdminActionName,
  AdminFilter,
  AdminSiteDetail,
  AdminSiteRow,
} from '@tela/shared/admin'
import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { displayHost, relativeTime } from '../../lib/format'
import { adminList } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps, Status } from '../area'
import { History, KeyValues, Note, Section, useWhen } from '../components/record'
import {
  BlogTile,
  blogName,
  count,
  languageOf,
  listingWords,
  loadSite,
  personName,
  RecordLink,
  restoreDone,
  restoreLabel,
  type Translate,
  topicWords,
  useDescribe,
} from './sites'

const loadDiscover = (filter: AdminFilter<'discover'>, q: string, signal?: AbortSignal) =>
  adminList<AdminSiteRow, 'discover'>('discover', filter, q, signal)

/** A private blog nobody claimed: one a member added, still to review or judged not for Discover. */
const added = (row: AdminSiteRow) => row.listing === 'private' && row.owner === null

/** A blog a member added that waits for a decision: no review yet (ADR 0041). */
const toReview = (row: AdminSiteRow) => added(row) && row.review === null

/** A blog a member added that an operator judged not for Discover, or hid over nothing decided. */
const dismissed = (row: AdminSiteRow) => added(row) && row.review === 'dismissed'

/** Where Discover lists the blog now, in the words its filters use. */
export function discoverWords(t: Translate, row: AdminSiteRow): string {
  if (toReview(row)) return t('listing.toReview')
  if (dismissed(row)) return t('listing.dismissed')
  return listingWords(t, row, true)
}

/** A row's dot: featured is good news, hidden a veto, waiting for review a question. */
export function discoverStatus(t: Translate, row: AdminSiteRow): Status {
  const tone =
    row.listing === 'featured'
      ? 'ok'
      : row.listing === 'rejected'
        ? 'bad'
        : toReview(row)
          ? 'info'
          : 'neutral'
  return { tone, label: discoverWords(t, row) }
}

/** Listed or featured: where a blog with no topics shows only under All. */
const shown = (listing: AdminSiteRow['listing']) => listing === 'listed' || listing === 'featured'

/**
 * The toast's words for an action that leaves a blog in Discover with no topics: it is filed
 * only under All until it has one, which the record's chips set in a click each.
 */
export function discoverDone(
  t: Translate,
  row: AdminSiteRow,
  action: AdminActionName,
): string | undefined {
  if (row.topics.length === 0 && action === 'site.list') return t('actionsDone.listedNoTopics')
  if (row.topics.length === 0 && action === 'site.feature') return t('actionsDone.featuredNoTopics')
  return restoreDone(t, row.listing, action)
}

/**
 * A row's line under its name: the address and language, then what the filter is about. For a
 * blog a member added, when it came (never who brought it); for one Discover lists, its topics,
 * or that it has none, since then it shows only under All.
 */
function discoverSub(t: Translate, row: AdminSiteRow, locale: string): string {
  const about = shown(row.listing)
    ? row.topics.length
      ? topicWords(t, row.topics)
      : t('noTopics')
    : t('addedWhen', { when: relativeTime(row.createdAt, locale) })
  const lang = row.primaryLang ? languageOf(t, row.primaryLang, locale) : null
  return [displayHost(row.homeUrl), row.owner ? personName(t, row.owner) : null, lang, about]
    .filter(Boolean)
    .join(' · ')
}

function discoverSpec(
  t: Translate,
  locale: string,
): AreaSpec<'discover', AdminSiteRow, AdminSiteDetail> {
  return {
    area: 'discover',
    filterLabel: (filter) => t(`filters.discover.${filter}`),
    searchHint: t('search.discover'),
    load: loadDiscover,
    loadDetail: loadSite,
    rowOf: (detail) => detail.site,
    name: {
      label: t('names.blog'),
      title: (row) => blogName(row.title, row.homeUrl),
      sub: (row) => discoverSub(t, row, locale),
      tile: (row) => <BlogTile {...row} />,
    },
    columns: [
      {
        label: t('columns.latest'),
        text: (row) => row.latestTitle ?? t('none'),
        number: (row) => row.latestAt,
      },
      {
        label: t('columns.posts30d'),
        text: (row) => count(row.postsLast30d, locale),
        number: (row) => row.postsLast30d,
      },
      {
        label: t('columns.readers'),
        text: (row) => count(row.readerCount, locale),
        number: (row) => row.readerCount,
      },
    ],
    status: (row) => discoverStatus(t, row),
    Record: DiscoverRecord,
    bulk: ['site.list', 'site.dismiss', 'site.feature', 'site.hide'],
    actionLabel: (row, action) => restoreLabel(t, row, action),
    actionDone: (row, action) => discoverDone(t, row, action),
    queue: true,
  }
}

export function useDiscoverArea(): AnyAreaSpec {
  const t = useTranslations('admin.library')
  const locale = useLocale()
  return useMemo(() => discoverSpec(t, locale), [t, locale])
}

const chip = (on: boolean) =>
  `cursor-pointer rounded-full border px-3 py-1 text-[12.5px] ${
    on ? 'border-ink bg-ink text-paper' : 'border-line text-ink-2 hover:border-ink'
  }`

/** The blog's topics, each a toggle: Discover's nine, in Discover's order. */
function TopicChips({
  topics,
  busy,
  onToggle,
}: {
  topics: readonly string[]
  /** The last click's list is still on its way: the next builds on what the server keeps. */
  busy: boolean
  onToggle: (topic: string) => void
}) {
  const t = useTranslations('admin.library')
  return (
    <Section label={t('sections.topics')}>
      <div className="flex flex-wrap gap-1.5">
        {TOPICS.map((topic) => (
          <button
            key={topic}
            type="button"
            aria-pressed={topics.includes(topic)}
            disabled={busy}
            onClick={() => onToggle(topic)}
            className={`${chip(topics.includes(topic))} disabled:cursor-default disabled:opacity-60`}
          >
            {t(`topics.${topic}`)}
          </button>
        ))}
      </div>
      <p className="m-0 text-[12.5px] text-muted">{t('notes.topicsHint')}</p>
    </Section>
  )
}

function DiscoverRecord({
  row,
  detail,
  act,
  open,
  busy,
}: RecordProps<AdminSiteRow, AdminSiteDetail>) {
  const t = useTranslations('admin.library')
  const locale = useLocale()
  const when = useWhen()
  const describe = useDescribe()
  const site = detail?.site ?? row
  // A click sends the whole new list. Until the ledger hands over the row or record again, the
  // chips show the list just sent, so a second click builds on the first rather than on the list
  // from before it; whatever the ledger hands over next is what the server kept.
  const [sent, setSent] = useState<string[] | null>(null)
  useEffect(() => {
    void site
    setSent(null)
  }, [site])
  const topics = sent ?? site.topics
  const toggle = (topic: string) => {
    const next = topics.includes(topic)
      ? topics.filter((x) => x !== topic)
      : TOPICS.filter((x) => x === topic || topics.includes(x))
    // Shown as sent only once it went: a click while another action is out sends nothing.
    if (act('site.topics', [row.id], { topics: next })) setSent(next)
  }
  const owner = site.owner
  const ownerLink = owner ? (
    <RecordLink onClick={() => open('people', owner.id)}>{personName(t, owner)}</RecordLink>
  ) : (
    t('listing.unclaimed')
  )
  const latest = site.latestTitle
    ? t('kv.latestValue', { title: site.latestTitle, when: when(site.latestAt) })
    : null
  return (
    <div className="flex flex-col gap-5">
      <KeyValues
        rows={[
          [t('kv.listing'), discoverWords(t, site)],
          [t('kv.owner'), ownerLink],
          [t('kv.language'), languageOf(t, site.primaryLang, locale)],
          [t('kv.readers'), count(site.readerCount, locale)],
          [t('kv.posts30d'), count(site.postsLast30d, locale)],
          [t('kv.latest'), latest],
          [t('kv.added'), when(site.createdAt)],
          [t('kv.about'), detail?.description ?? null],
        ]}
      />
      {toReview(site) ? <Note>{t('notes.review')}</Note> : null}
      {dismissed(site) ? (
        <Note>{t('notes.dismissed', { when: when(site.reviewedAt) })}</Note>
      ) : null}
      {shown(site.listing) && topics.length === 0 ? <Note>{t('notes.noTopics')}</Note> : null}
      <TopicChips topics={topics} busy={busy} onToggle={toggle} />
      <Note>{t('notes.discoverLag')}</Note>
      {detail ? <History entries={detail.history} describe={describe} /> : null}
    </div>
  )
}
