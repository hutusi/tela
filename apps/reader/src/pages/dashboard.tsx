/** What a blogger sees about the blogs they claimed: readers, posts and how they landed, notes. */
import { LANGUAGE_NAMES, TOPICS, type UiLocale } from '@tela/shared'
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { LoadFailed } from '../components/load-failed'
import { PersonAvatar } from '../components/person-avatar'
import { SettingRow } from '../components/setting-row'
import { SiteAvatar } from '../components/site-avatar'
import { Switch } from '../components/switch'
import { blogAddress, shortDate } from '../lib/format'
import { useTitle } from '../lib/title'
import { showToast } from '../lib/toasts'
import { BELOW_MD, useMediaQuery } from '../lib/use-media'
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
  /** "Only use what my feed provides" (ADR 0061). Absent from a tela-api older than it. */
  feedOnly?: boolean
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

const SECTION_TITLE = 'm-0 font-serif text-[24px] font-medium max-md:text-[22px]'
const HEADER = 'border-b border-line pb-2.5 text-[11px] font-semibold tracking-[0.08em] uppercase'
const CELL = 'border-b border-line py-3 align-top'
const NUMBER = `${CELL} pl-4 text-right tabular-nums`
/** A tile's line under its number. */
const SUB_LINE = 'text-[12.5px] max-md:text-[11.5px] max-md:leading-[1.3]'

type Post = Site['posts'][number]

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
      className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface px-5 py-[18px] max-md:min-w-0 max-md:gap-1 max-md:px-3 max-md:py-3"
      data-testid={testId}
    >
      <span className="text-[13px] text-muted max-md:text-[12px]">{label}</span>
      <span className="font-serif text-[34px] leading-none font-medium tabular-nums max-md:text-[28px]">
        {value}
      </span>
      {children}
    </div>
  )
}

/**
 * A post as a phone lists it, in the table's place: its title, then its date and how it landed on
 * one line. A part with nothing to say (no date, no notes) is left out rather than shown empty.
 */
function PostRow({ post, locale, now }: { post: Post; locale: string; now: number }) {
  const t = useTranslations('dashboard')
  const bold = (chunks: ReactNode) => <b className="font-medium text-ink">{chunks}</b>
  const parts = [
    {
      key: 'date',
      text: post.publishedAt === null ? null : shortDate(post.publishedAt, locale, now),
    },
    { key: 'likes', text: t.rich('row.likes', { n: post.likeCount, b: bold }) },
    {
      key: 'recommendations',
      text: t.rich('row.recommendations', { n: post.recommendCount, b: bold }),
    },
    { key: 'notes', text: post.noteCount > 0 ? t('row.notes', { n: post.noteCount }) : null },
  ].filter((part) => part.text !== null)
  return (
    <div className="border-b border-line py-3.5" data-testid="dashboard-post">
      <PostTitle
        title={post.title}
        url={post.url}
        className="font-serif text-[18px] leading-[1.25] text-ink hover:underline"
      />
      <div className="mt-1 text-[12.5px] text-muted" data-testid="dashboard-post-stats">
        {parts.map((part, i) => (
          <Fragment key={part.key}>
            {i > 0 ? ' · ' : null}
            {part.text}
          </Fragment>
        ))}
      </div>
    </div>
  )
}

export function DashboardPage() {
  const t = useTranslations('dashboard')
  const td = useTranslations('discover')
  const { locale } = useUi()
  const [dash, setDash] = useState<Dashboard | null>(null)
  // The answer did not come (offline, an error): Try again asks once more.
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useTitle(t('title'))

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Try again
  useEffect(() => {
    const controller = new AbortController()
    setFailed(false)
    api('/api/v1/dashboard', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`dashboard: ${res.status}`)
        setDash((await res.json()) as Dashboard)
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [attempt])

  return (
    <main
      className="mx-auto flex w-full max-w-[960px] flex-1 animate-fade flex-col gap-10 px-5 pt-11 pb-24 max-md:gap-6 max-md:pt-6 md:px-12"
      data-testid="dashboard"
    >
      <div>
        <h1 className="mb-2 font-serif text-[40px] leading-[1.1] font-medium tracking-[-0.015em] max-md:text-[32px]">
          {t('title')}
        </h1>
        <p className="m-0 max-w-[620px] text-[15px] leading-normal text-ink-2 max-md:text-[14.5px]">
          {t('intro')}
        </p>
      </div>

      {!dash && failed ? <LoadFailed onRetry={() => setAttempt((n) => n + 1)} /> : null}

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
          onChange={(patch) =>
            setDash((held) =>
              held
                ? {
                    ...held,
                    sites: held.sites.map((s) => (s.id === site.id ? { ...s, ...patch } : s)),
                  }
                : held,
            )
          }
          onReleased={() =>
            setDash((held) =>
              held ? { ...held, sites: held.sites.filter((s) => s.id !== site.id) } : held,
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
  onChange,
  onReleased,
}: {
  site: Site
  notes: Note[]
  locale: string
  /** The blog's settings as tela-api answered a change to one. */
  onChange: (patch: Pick<Site, 'translationOptOut'> | Pick<Site, 'feedOnly'>) => void
  /** The member let the blog go: it is no longer theirs to show here. */
  onReleased: () => void
}) {
  const t = useTranslations('dashboard')
  const ts = useTranslations('site')
  const td = useTranslations('discover')
  const tc = useTranslations('common')
  const now = useNow()
  // Rows in the table's place, and the tiles' short labels (Tela Mobile 14).
  const phone = useMediaQuery(BELOW_MD)
  const title = site.title ?? blogAddress(site.homeUrl)
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  // In Discover's order, and only topics this build can name.
  const topics = TOPICS.filter((topic) => site.topics.includes(topic)).map((topic) =>
    td(`topics.${topic}`),
  )
  const listing = t(`listing.${site.listing}`)
  // Only a blog in Discover is found under its topics: "private under Design" says nothing true.
  const inDiscover = site.listing === 'listed' || site.listing === 'featured'
  const meta = [
    blogAddress(site.homeUrl),
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
      onChange({ translationOptOut: body.optOut })
      showToast(t(body.optOut ? 'translationOff' : 'translationOn', { blog: title }))
    } finally {
      saving.current = false
    }
  }
  const setFeedOnly = async (on: boolean) => {
    if (saving.current) return
    saving.current = true
    try {
      const { status, body } = await apiJson<{ feedOnly: boolean }>(
        `/api/v1/sites/${site.id}/feed-only`,
        { method: 'PUT', body: { feedOnly: on } },
      )
      if (status !== 200) return
      onChange({ feedOnly: body.feedOnly })
      showToast(t(body.feedOnly ? 'feedOnlyOn' : 'feedOnlyOff', { blog: title }))
    } finally {
      saving.current = false
    }
  }

  return (
    <section className="flex flex-col gap-10 max-md:gap-6" data-testid="dashboard-site">
      <div className="flex flex-wrap items-center gap-4 max-md:gap-3">
        <SiteAvatar
          id={site.id}
          title={title}
          faviconKey={site.faviconKey}
          size={52}
          radius={13}
          className="max-md:!size-11 max-md:!rounded-[11px] max-md:!text-[18px]"
        />
        <div className="min-w-[220px] flex-1 max-md:min-w-0">
          <h2 className="m-0 font-serif text-[26px] leading-[1.1] font-medium max-md:text-[22px]">
            <Link to={`/s/${site.id}`} className="text-ink hover:underline">
              {title}
            </Link>
          </h2>
          <div
            className="mt-1 text-[13px] text-muted [overflow-wrap:anywhere]"
            data-testid="dashboard-meta"
          >
            {meta.join(' · ')}
          </div>
        </div>
      </div>

      {/* Three abreast on a phone too, under shorter labels: each tile keeps the spans it has. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 max-md:grid-cols-3 max-md:gap-2">
        <Tile
          label={phone ? t('short.readers') : t('readers')}
          value={site.readerCount}
          testId="dashboard-readers"
        >
          {site.newReaders30d > 0 ? (
            <span className={`${SUB_LINE} text-accent`}>
              {t(phone ? 'short.newReaders' : 'newReaders', { n: site.newReaders30d })}
            </span>
          ) : null}
        </Tile>
        {/* The whole blog's, as the notes below are, not the twenty posts in the table. */}
        <Tile
          label={phone ? t('short.likes') : t('likes')}
          value={totals.likes}
          testId="dashboard-likes"
        >
          <span className={`${SUB_LINE} text-muted`}>{t('likesAcross', { n: totals.posts })}</span>
        </Tile>
        <Tile
          label={phone ? t('short.recommendations') : t('recommendations')}
          value={totals.recommendations}
          testId="dashboard-recommendations"
        >
          <span className={`${SUB_LINE} text-muted`}>{t('withNote', { n: totals.notes })}</span>
        </Tile>
      </div>

      <section>
        <h3 className={`${SECTION_TITLE} mb-3.5 max-md:mb-1`}>{t('posts')}</h3>
        {phone ? (
          site.posts.map((post) => <PostRow key={post.id} post={post} locale={locale} now={now} />)
        ) : (
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
        )}
      </section>

      <section data-testid="dashboard-notes">
        <h3 className={`${SECTION_TITLE} mb-1`}>{t('notes')}</h3>
        {notes.length === 0 ? <p className="py-4 text-muted">{t('noNotes')}</p> : null}
        {notes.map((n) => {
          const name = n.displayName ?? `@${n.handle}`
          return (
            <div
              key={`${n.handle}:${n.articleId}`}
              className="grid grid-cols-[32px_minmax(0,1fr)] gap-3.5 border-b border-line py-[18px] max-md:grid-cols-[28px_minmax(0,1fr)] max-md:gap-3 max-md:py-3.5"
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
                  className="max-md:!size-7 max-md:!text-[12px]"
                />
              </Link>
              <div className="flex min-w-0 flex-col gap-1.5">
                <p className="m-0 font-serif text-[19px] leading-[1.4] text-pretty italic max-md:text-[18px]">
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
        {/* A tela-api that does not say has no such switch yet: none is shown. */}
        {site.feedOnly === undefined ? null : (
          <SettingRow
            label={t('feedOnly')}
            hint={t.rich('feedOnlyHint', {
              link: (chunks) => <Link to="/writers#opt-out">{chunks}</Link>,
            })}
          >
            <Switch
              checked={site.feedOnly}
              onChange={(on) => void setFeedOnly(on).catch(() => undefined)}
              label={t('feedOnly')}
              testId="dashboard-feed-only"
            />
          </SettingRow>
        )}
        <ReleaseRow siteId={site.id} title={title} onReleased={onReleased} />
      </section>
    </section>
  )
}

/**
 * Release this blog (ADR 0058): the claim lets go, as an operator's removal does, and the blog
 * keeps what its writer chose for it. Asked once more in place before it goes, since only a new
 * claim brings it back.
 */
function ReleaseRow({
  siteId,
  title,
  onReleased,
}: {
  siteId: number
  title: string
  onReleased: () => void
}) {
  const t = useTranslations('dashboard')
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const release = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const res = await api(`/api/v1/claims/${siteId}/release`, { method: 'POST', body: {} })
      if (!res.ok) throw new Error(`release: ${res.status}`)
      showToast(t('release.done', { blog: title }))
      onReleased()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const pill =
    'rounded-full border border-thumb px-3.5 py-[7px] text-[13px] font-medium whitespace-nowrap hover:border-ink disabled:opacity-60'
  return (
    <SettingRow
      label={t('release.label')}
      hint={asking ? t('release.confirm', { blog: title }) : t('release.hint')}
      testId="dashboard-release-row"
    >
      {asking ? (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void release()}
            className={`${pill} border-danger text-danger`}
            data-testid="dashboard-release-confirm"
          >
            {t('release.yes')}
          </button>
          <button
            type="button"
            onClick={() => setAsking(false)}
            className={`${pill} text-muted hover:text-ink`}
          >
            {t('release.keep')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAsking(true)}
          className={`${pill} text-ink`}
          data-testid="dashboard-release"
        >
          {t('release.open')}
        </button>
      )}
      {failed ? (
        <p role="alert" className="m-0 basis-full text-[13px] text-danger">
          {t('release.failed')}
        </p>
      ) : null}
    </SettingRow>
  )
}
