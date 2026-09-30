/** What a blogger sees about the blogs they claimed: readers, posts and how they landed, notes. */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { SiteAvatar } from '../components/site-avatar'
import { displayHost, relativeTime } from '../lib/format'
import { useTitle } from '../lib/title'
import { api, apiJson } from '../store/api'
import { useNow } from '../store/hooks'
import { useUi } from '../ui'

type Dashboard = {
  sites: {
    id: number
    title: string | null
    homeUrl: string
    faviconKey: string | null
    listing: 'private' | 'listed' | 'featured' | 'rejected'
    readerCount: number
    translationOptOut: boolean
    posts: {
      id: number
      title: string
      url: string | null
      publishedAt: number | null
      likeCount: number
      recommendCount: number
    }[]
  }[]
  notes: {
    note: string
    createdAt: number
    articleId: number
    articleTitle: string
    articleUrl: string | null
    handle: string
    displayName: string | null
  }[]
}

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

export function DashboardPage() {
  const t = useTranslations('dashboard')
  const td = useTranslations('discover')
  const { locale } = useUi()
  const now = useNow()
  const [dash, setDash] = useState<Dashboard | null>(null)
  useTitle(t('title'))

  const load = useCallback(async (signal?: AbortSignal) => {
    const res = await api('/api/v1/dashboard', signal ? { signal } : {})
    if (res.ok) setDash((await res.json()) as Dashboard)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).catch(() => undefined)
    return () => controller.abort()
  }, [load])

  const setOptOut = async (siteId: number, optOut: boolean) => {
    const { status } = await apiJson(`/api/v1/sites/${siteId}/translation`, {
      method: 'PUT',
      body: { optOut },
    })
    if (status === 200) await load()
  }

  return (
    <main
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-12 animate-fade md:px-8"
      data-testid="dashboard"
    >
      <div>
        <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
          {t('title')}
        </h1>
        <p className="mt-2 text-[15px] text-ink-2">{t('intro')}</p>
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
        <section key={site.id} className="flex flex-col gap-4" data-testid="dashboard-site">
          <div className="flex flex-wrap items-center gap-4">
            <SiteAvatar
              id={site.id}
              title={site.title ?? site.homeUrl}
              faviconKey={site.faviconKey}
              size={44}
            />
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-serif text-[24px] font-medium leading-tight">
                <Link to={`/s/${site.id}`} className="text-ink hover:underline">
                  {site.title ?? displayHost(site.homeUrl)}
                </Link>
              </h2>
              <div className="text-[13px] text-muted">
                {displayHost(site.homeUrl)} · {td('readers', { n: site.readerCount })} ·{' '}
                {t(`listing.${site.listing}`)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void setOptOut(site.id, !site.translationOptOut)}
              className="rounded-full border border-line px-3 py-1.5 text-[13px] hover:border-ink"
              data-testid="translation-optout"
            >
              {site.translationOptOut ? t('allowTranslation') : t('optOutTranslation')}
            </button>
          </div>
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-muted">
                <th className="border-b border-line py-2 font-semibold">{t('post')}</th>
                <th className="border-b border-line py-2 text-right font-semibold">♡</th>
                <th className="border-b border-line py-2 text-right font-semibold">↗</th>
              </tr>
            </thead>
            <tbody>
              {site.posts.map((post) => (
                <tr key={post.id} data-testid="dashboard-post">
                  <td className="border-b border-line py-2.5 pr-4">
                    <PostTitle
                      title={post.title}
                      url={post.url}
                      className="font-serif text-[17px] text-ink hover:underline"
                    />
                    <div className="text-[12px] text-muted">
                      {relativeTime(post.publishedAt, locale, now)}
                    </div>
                  </td>
                  <td className="border-b border-line py-2.5 text-right tabular-nums">
                    {post.likeCount}
                  </td>
                  <td className="border-b border-line py-2.5 text-right tabular-nums">
                    {post.recommendCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {dash && dash.sites.length > 0 ? (
        <section className="flex flex-col gap-3" data-testid="dashboard-notes">
          <h2 className="font-serif text-[22px] font-medium">{t('notes')}</h2>
          {dash.notes.length === 0 ? <p className="text-muted">{t('noNotes')}</p> : null}
          {dash.notes.map((n) => (
            <blockquote
              key={`${n.handle}:${n.articleId}`}
              className="m-0 rounded-xl border border-line bg-surface p-4"
            >
              <p className="m-0 font-serif text-[17px] leading-[1.45] text-body">{n.note}</p>
              <footer className="mt-2 text-[12.5px] text-muted">
                <Link to={`/@${n.handle}`}>@{n.handle}</Link>
                {' · '}
                <PostTitle title={n.articleTitle} url={n.articleUrl} />
                {' · '}
                {relativeTime(n.createdAt, locale, now)}
              </footer>
            </blockquote>
          ))}
        </section>
      ) : null}
    </main>
  )
}
