/** A blog's public page (`/s/:siteId`): what it is, who reads it, its latest posts. */
import { languageBadge } from '@tela/shared'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { SiteAvatar } from '../components/site-avatar'
import { displayHost, relativeTime } from '../lib/format'
import { PostLink } from './post-link'
import type { MemberControls, SiteData } from './types'

export function SiteView({
  data,
  member,
  locale,
  now,
  ownerPanel,
}: {
  data: SiteData
  member?: MemberControls | undefined
  locale: string
  now: number
  /** The blog's settings, shown to the member who claimed it. */
  ownerPanel?: React.ReactNode
}) {
  const t = useTranslations('site')
  const td = useTranslations('discover')
  const { site } = data
  const title = site.title ?? displayHost(site.homeUrl)
  const primary = data.feeds[0]
  const subscribed = primary !== undefined && member?.isSubscribed(primary.id) === true
  const here = `/s/${site.id}`

  return (
    <main
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-12 animate-fade md:px-8"
      data-testid="site-page"
    >
      <header className="flex flex-wrap items-start gap-5">
        <SiteAvatar id={site.id} title={title} faviconKey={site.faviconKey} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 font-serif text-[34px] font-medium leading-tight tracking-tight">
            <span className="truncate">{title}</span>
            {site.claimedBy ? (
              <span
                className="text-lg text-accent"
                title={td('claimed')}
                data-testid="claimed-badge"
              >
                ✓
              </span>
            ) : null}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <a href={site.homeUrl} target="_blank" rel="noopener noreferrer">
              {displayHost(site.homeUrl)} ↗
            </a>
            {site.primaryLang ? <span>{languageBadge(site.primaryLang)}</span> : null}
            <span>{td('readers', { n: site.readerCount })}</span>
            {site.claimedBy ? (
              <Link to={`/@${site.claimedBy}`}>{t('claimedBy', { handle: site.claimedBy })}</Link>
            ) : null}
          </div>
          {site.description ? (
            <p className="mt-3 max-w-xl font-serif text-[18px] leading-[1.4] text-body">
              {site.description}
            </p>
          ) : null}
          {data.topics.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {data.topics.map((topic) => (
                <Link
                  key={topic}
                  to={`/discover?topic=${topic}`}
                  className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-ink-2 hover:border-ink hover:no-underline"
                >
                  {td(`topics.${topic}`)}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          {primary ? (
            member ? (
              <button
                type="button"
                onClick={() => member.toggle(primary.id, subscribed)}
                data-testid="site-subscribe"
                aria-pressed={subscribed}
                className={`rounded-full border px-4 py-2 text-[13px] font-medium ${
                  subscribed ? 'border-line text-ink-2' : 'border-ink bg-ink text-paper'
                }`}
              >
                {subscribed ? td('subscribed') : td('subscribe')}
              </button>
            ) : (
              <Link
                to={`/login?next=${encodeURIComponent(here)}`}
                className="rounded-full border border-ink bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:no-underline"
              >
                {td('subscribe')}
              </Link>
            )
          ) : null}
          {!site.claimedBy && member ? (
            <Link
              to={`/sites/${site.id}/claim`}
              className="text-[13px] text-muted hover:text-ink"
              data-testid="claim-link"
            >
              {t('claimLink')}
            </Link>
          ) : null}
        </div>
      </header>

      {ownerPanel}

      <section>
        <h2 className="mb-3 font-serif text-[22px] font-medium">{t('latestPosts')}</h2>
        {data.posts.length === 0 ? (
          <p className="text-muted">{t('noPosts')}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0" data-testid="site-articles">
            {data.posts.map((a) => (
              <li key={a.id} className="border-t border-line py-3">
                <PostLink
                  article={a}
                  source={title}
                  member={member}
                  className="font-serif text-[19px] font-medium leading-tight text-ink hover:underline"
                />
                <div className="mt-1 text-[12.5px] text-muted">
                  {relativeTime(a.publishedAt ?? a.fetchedAt, locale, now)}
                  {a.sourceLang ? ` · ${languageBadge(a.sourceLang)}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
