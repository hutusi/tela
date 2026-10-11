/** What a blogger sees about the blogs they claimed: readers, posts and how they landed, notes. */
import { LANGUAGE_NAMES, TOPICS, type UiLocale } from '@tela/shared'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { PersonAvatar } from '../components/person-avatar'
import { SettingRow } from '../components/setting-row'
import { SiteAvatar } from '../components/site-avatar'
import { Switch } from '../components/switch'
import { displayHost, shortDate } from '../lib/format'
import { useTitle } from '../lib/title'
import { showToast } from '../lib/toasts'
import { api, apiJson } from '../store/api'
import { useNow } from '../store/hooks'
import { useUi } from '../ui'

type Site = {
  id: number
  title: string | null
  homeUrl: string
  faviconKey: string | null
  listing: 'private' | 'listed' | 'featured' | 'rejected'
  primaryLang: string | null
  topics: string[]
  readerCount: number
  /** Members whose first live subscription to the blog is under 30 days old. */
  newReaders30d: number
  translationOptOut: boolean
  /** The whole blog's: every post, and every live like, recommendation and note on them. */
  totals: { posts: number; likes: number; recommendations: number; notes: number }
  /** The newest twenty. */
  posts: {
    id: number
    title: string
    url: string | null
    publishedAt: number | null
    likeCount: number
    recommendCount: number
    /** Of `recommendCount`, those with a note. */
    noteCount: number
  }[]
}

type Note = {
  note: string
  createdAt: number
  siteId: number
  articleId: number
  articleTitle: string
  articleUrl: string | null
  handle: string
  displayName: string | null
  avatar: string | null
}

type Dashboard = { sites: Site[]; notes: Note[] }

const SECTION_TITLE = 'm-0 font-serif text-[24px] font-medium'
const HEADER = 'border-b border-line pb-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase'
const CELL = 'border-b border-line py-3 align-top'
const NUMBER = `${CELL} pl-4 text-right tabular-nums`

/** A post the blogger wrote opens on their own blog. */
function PostTitle({
  title,
  url,
  className,
}: {
  title: string
  url: string | null
  className?: string
}) {
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className={className}>
      {title}
    </a>
  ) : (
    <span className={className}>{title}</span>
  )
}

/** One of the three numbers over the posts: a label, the number, and a line on what it counts. */
function Tile({
  label,
  value,
  children,
  testId,
}: {
  label: string
  value: number
  children?: React.ReactNode
  testId: string
}) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface px-5 py-[18px]"
      data-testid={testId}
    >
      <span className="text-[13px] text-muted">{label}</span>
      <span className="font-serif text-[34px] leading-none font-medium tabular-nums">{value}</span>
      {children}
    </div>
  )
}

export function DashboardPage() {
  const t = useTranslations('dashboard')
  const td = useTranslations('discover')
  const { locale } = useUi()
  const [dash, setDash] = useState<Dashboard | null>(null)
  useTitle(t('title'))

  useEffect(() => {
    const controller = new AbortController()
    api('/api/v1/dashboard', { signal: controller.signal })
      .then(async (res) => {
        if (res.ok) setDash((await res.json()) as Dashboard)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  return (
    <main
      className="mx-auto flex w-full max-w-[960px] flex-1 animate-fade flex-col gap-10 px-4 pt-11 pb-24 md:px-12"
      data-testid="dashboard"
    >
      <div>
        <h1 className="mb-2 font-serif text-[40px] leading-[1.1] font-medium tracking-[-0.015em]">
          {t('title')}
        </h1>
        <p className="m-0 max-w-[620px] text-[15px] leading-normal text-ink-2">{t('intro')}</p>
      </div>

      {dash && dash.sites.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-6">
          <p className="mb-3 text-ink-2">{t('noSites')}</p>
          <Link
            to="/claim"
            className="inline-block rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:no-underline"
          >
            {td('claim.cta')}
          </Link>
        </div>
      ) : null}

      {dash?.sites.map((site) => (
        <SiteDashboard
          key={site.id}
          site={site}
          notes={dash.notes.filter((n) => n.siteId === site.id)}
          locale={locale}
          onTranslation={(optOut) =>
            setDash((held) =>
              held
                ? {
                    ...held,
                    sites: held.sites.map((s) =>
                      s.id === site.id ? { ...s, translationOptOut: optOut } : s,
                    ),
                  }
                : held,
            )
          }
        />
      ))}
    </main>
  )
}

/** One claimed blog: who reads it, how its posts landed, what readers said, and its setting. */
function SiteDashboard({
  site,
  notes,
  locale,
  onTranslation,
}: {
  site: Site
  notes: Note[]
  locale: string
  /** The blog's translation setting as tela-api answered it. */
  onTranslation: (optOut: boolean) => void
}) {
  const t = useTranslations('dashboard')
  const ts = useTranslations('site')
  const td = useTranslations('discover')
  const tc = useTranslations('common')
  const now = useNow()
  const title = site.title ?? displayHost(site.homeUrl)
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  // In Discover's order, and only topics this build can name.
  const topics = TOPICS.filter((topic) => site.topics.includes(topic)).map((topic) =>
    td(`topics.${topic}`),
  )
  const listing = t(`listing.${site.listing}`)
  // Only a blog in Discover is found under its topics: "private under Design" says nothing true.
  const inDiscover = site.listing === 'listed' || site.listing === 'featured'
  const meta = [
    displayHost(site.homeUrl),
    site.primaryLang
      ? ts('writtenIn', { lang: names[site.primaryLang] ?? site.primaryLang })
      : null,
    inDiscover && topics.length > 0
      ? t('listedUnder', { listing, topics: topics.join(t('listSeparator')) })
      : listing,
  ].filter((part) => part !== null)
  const { totals } = site

  // One change at a time: a press while one is on its way would send what the switch showed
  // before the first one landed.
  const saving = useRef(false)
  const setTranslation = async (on: boolean) => {
    if (saving.current) return
    saving.current = true
    try {
      const { status, body } = await apiJson<{ optOut: boolean }>(
        `/api/v1/sites/${site.id}/translation`,
        { method: 'PUT', body: { optOut: !on } },
      )
      if (status !== 200) return
      onTranslation(body.optOut)
      showToast(t(body.optOut ? 'translationOff' : 'translationOn', { blog: title }))
    } finally {
      saving.current = false
    }
  }

  return (
    <section className="flex flex-col gap-10" data-testid="dashboard-site">
      <div className="flex flex-wrap items-center gap-4">
        <SiteAvatar id={site.id} title={title} faviconKey={site.faviconKey} size={52} radius={13} />
        <div className="min-w-[220px] flex-1">
          <h2 className="m-0 font-serif text-[26px] leading-[1.1] font-medium">
            <Link to={`/s/${site.id}`} className="text-ink hover:underline">
              {title}
            </Link>
          </h2>
          <div className="mt-1 text-[13px] text-muted" data-testid="dashboard-meta">
            {meta.join(' · ')}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <Tile label={t('readers')} value={site.readerCount} testId="dashboard-readers">
          {site.newReaders30d > 0 ? (
            <span className="text-[12.5px] text-accent">
              {t('newReaders', { n: site.newReaders30d })}
            </span>
          ) : null}
        </Tile>
        {/* The whole blog's, as the notes below are, not the twenty posts in the table. */}
        <Tile label={t('likes')} value={totals.likes} testId="dashboard-likes">
          <span className="text-[12.5px] text-muted">{t('likesAcross', { n: totals.posts })}</span>
        </Tile>
        <Tile
          label={t('recommendations')}
          value={totals.recommendations}
          testId="dashboard-recommendations"
        >
          <span className="text-[12.5px] text-muted">{t('withNote', { n: totals.notes })}</span>
        </Tile>
      </div>

      <section>
        <h3 className={`${SECTION_TITLE} mb-3.5`}>{t('posts')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="text-muted">
                <th className={`${HEADER} text-left`}>{t('post')}</th>
                <th className={`${HEADER} pl-4 text-right`}>{t('likes')}</th>
                <th className={`${HEADER} pl-4 text-right`}>{t('recommendations')}</th>
                <th className={`${HEADER} pl-4 text-right`}>{t('notesColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {site.posts.map((post) => (
                <tr key={post.id} data-testid="dashboard-post">
                  <td className={CELL}>
                    <PostTitle
                      title={post.title}
                      url={post.url}
                      className="font-serif text-[18px] leading-[1.25] text-ink hover:underline"
                    />
                    {post.publishedAt === null ? null : (
                      <div className="mt-0.5 text-[12px] text-muted">
                        {shortDate(post.publishedAt, locale, now)}
                      </div>
                    )}
                  </td>
                  <td className={NUMBER}>{post.likeCount}</td>
                  <td className={NUMBER}>{post.recommendCount}</td>
                  <td className={NUMBER}>{post.noteCount || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section data-testid="dashboard-notes">
        <h3 className={`${SECTION_TITLE} mb-1`}>{t('notes')}</h3>
        {notes.length === 0 ? <p className="py-4 text-muted">{t('noNotes')}</p> : null}
        {notes.map((n) => {
          const name = n.displayName ?? `@${n.handle}`
          return (
            <div
              key={`${n.handle}:${n.articleId}`}
              className="grid grid-cols-[32px_minmax(0,1fr)] gap-3.5 border-b border-line py-[18px]"
            >
              <Link
                to={`/@${n.handle}`}
                tabIndex={-1}
                aria-hidden="true"
                className="self-start rounded-full hover:no-underline"
              >
                <PersonAvatar
                  handle={n.handle}
                  displayName={n.displayName}
                  avatar={n.avatar}
                  size={32}
                />
              </Link>
              <div className="flex min-w-0 flex-col gap-1.5">
                <p className="m-0 font-serif text-[19px] leading-[1.4] text-pretty italic">
                  {tc('quoted', { text: n.note })}
                </p>
                <div className="text-[12.5px] text-muted">
                  {ts.rich('noteOn', {
                    person: () => (
                      <Link to={`/@${n.handle}`} className="font-medium text-ink hover:underline">
                        {name}
                      </Link>
                    ),
                    post: () => (
                      <PostTitle
                        title={n.articleTitle}
                        url={n.articleUrl}
                        className="text-ink-2 hover:underline"
                      />
                    ),
                  })}
                  {' · '}
                  {shortDate(n.createdAt, locale, now)}
                </div>
              </div>
            </div>
          )
        })}
      </section>

      <section>
        <h3 className={`${SECTION_TITLE} mb-1`}>{t('onTela')}</h3>
        <SettingRow label={t('translate')} hint={t('translateHint')}>
          <Switch
            checked={!site.translationOptOut}
            onChange={(on) => void setTranslation(on).catch(() => undefined)}
            label={t('translate')}
            testId="dashboard-translate"
          />
        </SettingRow>
      </section>
    </section>
  )
}
