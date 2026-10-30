/**
 * The Discover ledger (ADR 0039): what the public directory shows, and the blogs members added
 * that wait for an operator's review (ADR 0041), where it opens. Featuring is an editor's call;
 * hiding is the veto that sticks (ADR 0018); Not for Discover takes a blog out of the queue and
 * leaves the community door open. A record's topic chips set where Discover files the blog. A
 * row shows the blog, never who added it.
 *
 * The Blogrolls filter lists members' public blogrolls instead (ADR 0050), which Discover lists on
 * its own once three blogs others see are in one; Hide from Discover keeps one out. Its columns,
 * its search and its record loader come from the filter, but every part that reads a row asks the
 * row what it is: for a moment the filter and the rows drawn under it can disagree (an answer
 * still on its way, a record found under another filter), and a blog's words read from a
 * blogroll's row would fail.
 */
import { BLOGROLL_DISCOVER_MIN, TOPICS } from '@tela/shared'
import type {
  AdminActionName,
  AdminBlogrollDetail,
  AdminBlogrollRow,
  AdminFilter,
  AdminSiteDetail,
  AdminSiteRow,
} from '@tela/shared/admin'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useLocale, useTranslations } from 'use-intl'
import { Swatch } from '../../components/swatch'
import { blogAddress, personColor, relativeTime } from '../../lib/format'
import { adminGet, adminList } from '../api'
import type { AnyAreaSpec, AreaSpec, Column, RecordProps, Status } from '../area'
import { History, KeyValues, Note, Section, StatusPill, useWhen } from '../components/record'
import { parseLedgerState } from '../state'
import {
  BlogLinks,
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
  shown,
  type Translate,
  topicWords,
  useDescribe,
} from './sites'

/** A row of Discover's ledger: a blog, or under Blogrolls a member's public blogroll. */
export type DiscoverRow = AdminSiteRow | AdminBlogrollRow
type DiscoverDetail = AdminSiteDetail | AdminBlogrollDetail

/** Whether a row is a blogroll's: what every part of the area asks before reading one. */
export const isBlogroll = (row: DiscoverRow): row is AdminBlogrollRow => 'blogrollId' in row

/** `site` over a blog's row, `blogroll` over a blogroll's. */
function byKind<T>(
  row: DiscoverRow,
  site: (row: AdminSiteRow) => T,
  blogroll: (row: AdminBlogrollRow) => T,
): T {
  return isBlogroll(row) ? blogroll(row) : site(row)
}

/** One endpoint for every filter: the server answers Blogrolls with blogrolls. */
const loadDiscover = (filter: AdminFilter<'discover'>, q: string, signal?: AbortSignal) =>
  adminList<DiscoverRow, 'discover'>('discover', filter, q, signal)

/** A public blogroll's record (`GET /blogrolls/:id`); a private one has none. */
export const loadBlogroll = (id: string, signal?: AbortSignal) =>
  adminGet<AdminBlogrollDetail>(`blogrolls/${encodeURIComponent(id)}`, signal)

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
  return [blogAddress(row.homeUrl), row.owner ? personName(t, row.owner) : null, lang, about]
    .filter(Boolean)
    .join(' · ')
}

/**
 * A blogroll's dot: listed in Discover is good news, hidden the operator's veto, and one with
 * fewer blogs others see than Discover asks for simply waits (ADR 0050).
 */
export function blogrollStatus(t: Translate, row: AdminBlogrollRow): Status {
  if (row.hiddenAt !== null) return { tone: 'bad', label: t('blogrolls.status.hidden') }
  if (row.inDiscover) return { tone: 'ok', label: t('blogrolls.status.listed') }
  return { tone: 'neutral', label: t('blogrolls.status.few', { n: BLOGROLL_DISCOVER_MIN }) }
}

/** How many blogs others see; and of how many, when the operator hid some of them. */
function blogCountWords(t: Translate, row: AdminBlogrollRow, locale: string): string {
  if (row.blogCount === row.totalCount) return count(row.blogCount, locale)
  return t('blogrolls.blogsOf', {
    shown: count(row.blogCount, locale),
    total: count(row.totalCount, locale),
  })
}

/** Its first blogs others see, by name: what a row says the blogroll is about. */
const firstBlogs = (t: Translate, row: AdminBlogrollRow) =>
  row.blogs.length
    ? row.blogs.map((b) => blogName(b.name, b.homeUrl)).join(t('listSeparator'))
    : t('none')

/** The square a blogroll's row starts with: its initial, in a colour its id keeps. */
function BlogrollTile({ id, name }: { id: string; name: string }) {
  return <Swatch id={0} title={name} color={personColor(id)} size={28} />
}

function discoverSpec(
  t: Translate,
  locale: string,
  blogrolls: boolean,
): AreaSpec<'discover', DiscoverRow, DiscoverDetail> {
  const none = () => t('none')
  const unknown = () => null
  const blogColumns: readonly [Column<DiscoverRow>, Column<DiscoverRow>, Column<DiscoverRow>] = [
    {
      label: t('columns.latest'),
      text: (row) => byKind(row, (r) => r.latestTitle ?? t('none'), none),
      number: (row) => byKind(row, (r) => r.latestAt, unknown),
    },
    {
      label: t('columns.posts30d'),
      text: (row) => byKind(row, (r) => count(r.postsLast30d, locale), none),
      number: (row) => byKind(row, (r) => r.postsLast30d, unknown),
    },
    {
      label: t('columns.readers'),
      text: (row) => byKind(row, (r) => count(r.readerCount, locale), none),
      number: (row) => byKind(row, (r) => r.readerCount, unknown),
    },
  ]
  const blogrollColumns: readonly [Column<DiscoverRow>, Column<DiscoverRow>, Column<DiscoverRow>] =
    [
      {
        label: t('columns.includes'),
        text: (row) => byKind(row, none, (r) => firstBlogs(t, r)),
      },
      {
        label: t('columns.blogs'),
        text: (row) => byKind(row, none, (r) => blogCountWords(t, r, locale)),
        number: (row) => byKind(row, unknown, (r) => r.blogCount),
      },
      {
        label: t('columns.publicSince'),
        text: (row) => byKind(row, none, (r) => relativeTime(r.publicSince, locale) || t('none')),
        number: (row) => byKind(row, unknown, (r) => r.publicSince),
      },
    ]
  return {
    area: 'discover',
    filterLabel: (filter) => t(`filters.discover.${filter}`),
    searchHint: blogrolls ? t('search.blogrolls') : t('search.discover'),
    load: loadDiscover,
    // Each kind of record its own way: the ledger draws a record only with the loader that
    // fetched it, so one fetched under a blog filter is fetched again under Blogrolls.
    loadDetail: blogrolls ? loadBlogroll : loadSite,
    rowOf: (detail) => ('blogroll' in detail ? detail.blogroll : detail.site),
    name: {
      label: blogrolls ? t('names.blogroll') : t('names.blog'),
      title: (row) =>
        byKind(
          row,
          (r) => blogName(r.title, r.homeUrl),
          (r) => r.name,
        ),
      sub: (row) =>
        byKind(
          row,
          (r) => discoverSub(t, r, locale),
          (r) => (r.owner ? personName(t, r.owner) : t('none')),
        ),
      tile: (row) =>
        byKind(
          row,
          (r) => <BlogTile {...r} />,
          (r) => <BlogrollTile id={r.id} name={r.name} />,
        ),
    },
    columns: blogrolls ? blogrollColumns : blogColumns,
    status: (row) =>
      byKind(
        row,
        (r) => discoverStatus(t, r),
        (r) => blogrollStatus(t, r),
      ),
    Record: DiscoverAreaRecord,
    bulk: blogrolls
      ? ['blogroll.hide', 'blogroll.restore']
      : ['site.list', 'site.dismiss', 'site.feature', 'site.hide'],
    // A blogroll's actions read as the shell names them.
    actionLabel: (row, action) =>
      byKind(
        row,
        (r) => restoreLabel(t, r, action),
        () => undefined,
      ),
    actionDone: (row, action) =>
      byKind(
        row,
        (r) => discoverDone(t, r, action),
        () => undefined,
      ),
    queue: true,
  }
}

export function useDiscoverArea(): AnyAreaSpec {
  const t = useTranslations('admin.library')
  const locale = useLocale()
  // The filter the address names, as the ledger reads it in the same render.
  const [params] = useSearchParams()
  const blogrolls = parseLedgerState('discover', params).filter === 'blogrolls'
  return useMemo(() => discoverSpec(t, locale, blogrolls), [t, locale, blogrolls])
}

/** A record drawn as what its row is, with the detail only when it is that kind's. */
function DiscoverAreaRecord({ row, detail, ...rest }: RecordProps<DiscoverRow, DiscoverDetail>) {
  if (isBlogroll(row)) {
    const own = detail && 'blogroll' in detail ? detail : null
    return <BlogrollRecord row={row} detail={own} {...rest} />
  }
  const own = detail && 'site' in detail ? detail : null
  return <DiscoverRecord row={row} detail={own} {...rest} />
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
  // Built apart from the rows, as values rather than items of a list React would key.
  const address = <BlogLinks site={site} />
  const latest = site.latestTitle
    ? t('kv.latestValue', { title: site.latestTitle, when: when(site.latestAt) })
    : null
  return (
    <div className="flex flex-col gap-5">
      <KeyValues
        rows={[
          [t('kv.address'), address],
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

/**
 * A public blogroll's record (ADR 0050): its member, its blogs in its order (those the operator
 * hid marked, since others do not see them), and what operators did. A Hide keeps it out of
 * Discover alone: its page and its place on its member's profile stay, and its member is not told.
 */
function BlogrollRecord({ row, detail, open }: RecordProps<AdminBlogrollRow, AdminBlogrollDetail>) {
  const t = useTranslations('admin.library')
  const locale = useLocale()
  const when = useWhen()
  const describe = useDescribe()
  const roll = detail?.blogroll ?? row
  const owner = roll.owner
  const ownerLink = owner ? (
    <RecordLink onClick={() => open('people', owner.id)}>{personName(t, owner)}</RecordLink>
  ) : (
    t('none')
  )
  return (
    <div className="flex flex-col gap-5" data-testid="admin-blogroll-record">
      <KeyValues
        rows={[
          [t('kv.status'), blogrollStatus(t, roll).label],
          [t('kv.owner'), ownerLink],
          [t('kv.blogs'), blogCountWords(t, roll, locale)],
          [t('kv.publicSince'), roll.publicSince === null ? null : when(roll.publicSince)],
          [t('kv.hidden'), roll.hiddenAt === null ? null : when(roll.hiddenAt)],
          [t('kv.about'), roll.description || null],
        ]}
      />
      {detail && detail.blogs.length > 0 ? (
        <Section label={t('sections.blogs')}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13.5px]">
            {detail.blogs.map((blog) => (
              <li key={blog.feedId} className="flex min-w-0 items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <BlogTile
                    siteId={blog.siteId}
                    title={blog.name}
                    homeUrl={blog.homeUrl}
                    faviconKey={blog.faviconKey}
                  />
                  <RecordLink onClick={() => open('sites', String(blog.siteId))}>
                    <span className="[overflow-wrap:anywhere]">
                      {blogName(blog.name, blog.homeUrl)}
                    </span>
                  </RecordLink>
                </span>
                {blog.shown ? null : <StatusPill tone="bad" label={t('listing.rejected')} />}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {detail?.blogs.some((b) => !b.shown) ? <Note>{t('notes.blogrollHiddenBlogs')}</Note> : null}
      <Note>{t('notes.blogrollHide')}</Note>
      <Note>{t('notes.discoverLag')}</Note>
      {detail ? <History entries={detail.history} describe={describe} /> : null}
    </div>
  )
}
