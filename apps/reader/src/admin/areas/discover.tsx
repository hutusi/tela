/**
 * The Discover ledger (ADR 0039): what the public directory shows, and the private blogs readers
 * already follow that it could. Featuring is an editor's call; hiding is the veto that sticks
 * (ADR 0018). A record's topic chips set where Discover files the blog.
 */
import { TOPICS } from '@tela/shared'
import type { AdminFilter, AdminSiteDetail, AdminSiteRow } from '@tela/shared/admin'
import { useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { displayHost } from '../../lib/format'
import { adminList } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps } from '../area'
import { History, KeyValues, Note, Section } from '../components/record'
import {
  BlogTile,
  blogName,
  count,
  languageOf,
  listingStatus,
  listingWords,
  loadSite,
  personName,
  RecordLink,
  restoreLabel,
  type Translate,
  topicWords,
  useDescribe,
} from './sites'

const loadDiscover = (filter: AdminFilter<'discover'>, q: string, signal?: AbortSignal) =>
  adminList<AdminSiteRow, 'discover'>('discover', filter, q, signal)

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
      sub: (row) =>
        [displayHost(row.homeUrl), row.owner ? personName(t, row.owner) : t('listing.unclaimed')]
          .filter(Boolean)
          .join(' · '),
      tile: (row) => <BlogTile {...row} />,
    },
    columns: [
      { label: t('columns.topics'), text: (row) => topicWords(t, row.topics) },
      { label: t('columns.language'), text: (row) => languageOf(t, row.primaryLang, locale) },
      {
        label: t('columns.readers'),
        text: (row) => count(row.readerCount, locale),
        number: (row) => row.readerCount,
      },
    ],
    status: (row) => listingStatus(t, row, true),
    Record: DiscoverRecord,
    bulk: ['site.feature', 'site.hide'],
    actionLabel: (row, action) => restoreLabel(t, row, action),
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
  return (
    <div className="flex flex-col gap-5">
      <KeyValues
        rows={[
          [t('kv.listing'), listingWords(t, site, true)],
          [t('kv.owner'), ownerLink],
          [t('kv.language'), languageOf(t, site.primaryLang, locale)],
          [t('kv.readers'), count(site.readerCount, locale)],
          [t('kv.about'), detail?.description ?? null],
        ]}
      />
      <TopicChips topics={topics} busy={busy} onToggle={toggle} />
      <Note>{t('notes.discoverLag')}</Note>
      {detail ? <History entries={detail.history} describe={describe} /> : null}
    </div>
  )
}
