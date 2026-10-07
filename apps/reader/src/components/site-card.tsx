import { languageBadge } from '@tela/shared'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { cadenceKey, displayHost } from '../lib/format'
import type { DiscoverSite, MemberControls } from '../views/types'

/** Discover knows everything about a blog; search knows less, and the card shows what there is. */
export type SiteCardData = Pick<
  DiscoverSite,
  'id' | 'title' | 'homeUrl' | 'description' | 'faviconKey' | 'readerCount' | 'feedId'
> &
  Partial<Pick<DiscoverSite, 'primaryLang' | 'claimed' | 'latestTitle' | 'postsLast30d'>>

import { SiteAvatar } from './site-avatar'

export function SiteCard({
  site,
  member,
  next,
}: {
  site: SiteCardData
  member?: MemberControls | undefined
  next: string
}) {
  const t = useTranslations('discover')
  const ts = useTranslations('site')
  const title = site.title ?? displayHost(site.homeUrl)
  const subscribed = site.feedId !== null && member?.isSubscribed(site.feedId) === true
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 animate-fade"
      data-testid="site-card"
      data-site-id={site.id}
    >
      <div className="flex items-center gap-3">
        <SiteAvatar id={site.id} title={title} faviconKey={site.faviconKey} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-medium">
            <Link to={`/s/${site.id}`} className="truncate text-ink hover:underline">
              {title}
            </Link>
            {site.claimed ? (
              <span
                title={t('claimed')}
                className="text-xs text-accent"
                data-testid="claimed-badge"
              >
                ✓
              </span>
            ) : null}
          </div>
          <div className="truncate text-[12.5px] text-muted">{displayHost(site.homeUrl)}</div>
        </div>
        {site.primaryLang ? (
          <span className="rounded border border-line px-1.5 py-px text-[11px] text-muted">
            {languageBadge(site.primaryLang)}
          </span>
        ) : null}
      </div>
      {site.description ? (
        <p className="m-0 line-clamp-3 font-serif text-[17px] leading-[1.4] text-body">
          {site.description}
        </p>
      ) : null}
      {site.latestTitle ? (
        <div className="text-[12.5px] text-muted">
          {t('latest')} <span className="text-ink-2">{site.latestTitle}</span>
        </div>
      ) : null}
      <div className="mt-auto flex items-center justify-between pt-1">
        <span className="text-[12.5px] text-muted">
          {site.readerCount === null
            ? // Kept back below three readers (ADR 0041): the card says nothing of readers, not
              // "no readers yet", and the cadence stands alone in the blog page's own words.
              site.postsLast30d === undefined
              ? null
              : ts('cadence', { key: cadenceKey(site.postsLast30d) })
            : t('readers', { n: site.readerCount }) +
              (site.postsLast30d === undefined
                ? ''
                : ` · ${t(`cadence.${cadenceKey(site.postsLast30d)}`)}`)}
        </span>
        {site.feedId === null ? null : member ? (
          <button
            type="button"
            onClick={() => site.feedId !== null && member.toggle(site.feedId, subscribed)}
            data-testid="site-subscribe"
            aria-pressed={subscribed}
            className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-all hover:brightness-95 ${
              subscribed ? 'border-line bg-transparent text-ink-2' : 'border-ink bg-ink text-paper'
            }`}
          >
            {subscribed ? t('subscribed') : t('subscribe')}
          </button>
        ) : (
          <Link
            to={`/login?next=${encodeURIComponent(next)}`}
            className="rounded-full border border-ink bg-ink px-3.5 py-1.5 text-[13px] font-medium text-paper hover:no-underline"
          >
            {t('subscribe')}
          </Link>
        )}
      </div>
    </div>
  )
}
