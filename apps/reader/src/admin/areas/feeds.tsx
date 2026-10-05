/**
 * The Feeds ledger (ADR 0039): the feeds that stopped. Failing ones with the error they last had,
 * ones timing out from Cloudflare (which the China relay may reach), dead, paused and merged ones;
 * and last, the ones fetching as they should, for an operator who must pause one.
 * A merged feed is read-only: its next fetch would merge it again (ADR 0028).
 */
import type { AdminFeedDetail, AdminFeedRow, AdminFilter } from '@tela/shared/admin'
import { useMemo } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { adminGet, adminList } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps } from '../area'
import { Evidence, History, KeyValues, Note, useWhen } from '../components/record'
import {
  BlogTile,
  blogName,
  count,
  feedAddress,
  feedErrorLabel,
  feedStatus,
  personName,
  RecordLink,
  type Translate,
  useDescribe,
} from './sites'

const loadFeeds = (filter: AdminFilter<'feeds'>, q: string, signal?: AbortSignal) =>
  adminList<AdminFeedRow, 'feeds'>('feeds', filter, q, signal)

const loadFeed = (id: string, signal?: AbortSignal) =>
  adminGet<AdminFeedDetail>(`feeds/${encodeURIComponent(id)}`, signal)

/** The Last error column: the kind of error while the feed has one, a dash otherwise. */
const lastError = (t: Translate, row: AdminFeedRow) =>
  row.errorCount > 0 || row.status === 'dead' ? feedErrorLabel(t, row.lastError) : t('none')

function feedsSpec(t: Translate): AreaSpec<'feeds', AdminFeedRow, AdminFeedDetail> {
  return {
    area: 'feeds',
    filterLabel: (filter) => t(`filters.feeds.${filter}`),
    searchHint: t('search.feeds'),
    load: loadFeeds,
    loadDetail: loadFeed,
    name: {
      label: t('names.feed'),
      title: (row) => feedAddress(row.feedUrl),
      sub: (row) =>
        [blogName(row.siteTitle, row.homeUrl), row.format ? t(`formats.${row.format}`) : null]
          .filter(Boolean)
          .join(' · '),
      tile: (row) => (
        <BlogTile
          siteId={row.siteId}
          title={row.siteTitle}
          homeUrl={row.homeUrl}
          faviconKey={row.faviconKey}
        />
      ),
    },
    columns: [
      { label: t('columns.blog'), text: (row) => blogName(row.siteTitle, row.homeUrl) },
      { label: t('columns.region'), text: (row) => t(`regions.${row.region}`) },
      { label: t('columns.lastError'), text: (row) => lastError(t, row) },
    ],
    status: (row) => feedStatus(t, row),
    Record: FeedRecord,
    bulk: ['feed.fetch', 'feed.pause'],
    queue: true,
  }
}

export function useFeedsArea(): AnyAreaSpec {
  const t = useTranslations('admin.library')
  return useMemo(() => feedsSpec(t), [t])
}

/** What a feed is doing, in words: an operator's pause and a merge said as such. */
function statusWords(t: Translate, feed: AdminFeedRow) {
  if (feed.mergedInto !== null) return t('status.merged')
  return t(`status.${feed.status}`)
}

function FeedRecord({ row, detail, open }: RecordProps<AdminFeedRow, AdminFeedDetail>) {
  const t = useTranslations('admin.library')
  const locale = useLocale()
  const when = useWhen()
  const describe = useDescribe()
  const feed = detail?.feed ?? row
  const live = feed.status === 'active' && feed.mergedInto === null
  const troubled = feed.errorCount > 0 || feed.status === 'dead'
  const blog = (
    <RecordLink onClick={() => open('sites', String(feed.siteId))}>
      {blogName(feed.siteTitle, feed.homeUrl)}
    </RecordLink>
  )
  const target = feed.mergedInto
  const mergedInto =
    target === null ? null : (
      <RecordLink onClick={() => open('feeds', String(target))}>
        {t('openFeed', { id: target })}
      </RecordLink>
    )
  const owner = feed.owner
  const ownerLink = owner ? (
    <RecordLink onClick={() => open('people', owner.id)}>{personName(t, owner)}</RecordLink>
  ) : null
  return (
    <div className="flex flex-col gap-5">
      <KeyValues
        rows={[
          [t('kv.blog'), blog],
          [t('kv.address'), feed.feedUrl],
          [t('kv.status'), statusWords(t, feed)],
          [t('kv.mergedInto'), mergedInto],
          [t('kv.errors'), feed.errorCount > 0 ? count(feed.errorCount, locale) : null],
          [t('kv.timeouts'), feed.timeoutStreak > 0 ? count(feed.timeoutStreak, locale) : null],
          [t('kv.lastFetched'), feed.lastFetchedAt === null ? null : when(feed.lastFetchedAt)],
          [t('kv.newestPost'), feed.lastItemAt === null ? null : when(feed.lastItemAt)],
          [t('kv.nextFetch'), live ? when(feed.nextFetchAt) : null],
          [t('kv.readers'), count(feed.readerCount, locale)],
          [t('kv.region'), t(`regions.${feed.region}`)],
          [t('kv.format'), feed.format ? t(`formats.${feed.format}`) : null],
          [t('kv.owner'), ownerLink],
        ]}
      />
      {troubled && feed.lastError ? (
        <Evidence
          label={
            feed.lastFetchedAt === null
              ? t('sections.lastError')
              : t('sections.lastCheck', { when: when(feed.lastFetchedAt) })
          }
          text={feed.lastError}
        />
      ) : null}
      {feed.mergedInto !== null ? <Note>{t('notes.merged')}</Note> : null}
      {detail && !detail.relay && live && feed.timeoutStreak >= 3 ? (
        <Note>{t('notes.noRelay')}</Note>
      ) : null}
      {detail ? <History entries={detail.history} describe={describe} /> : null}
    </div>
  )
}
