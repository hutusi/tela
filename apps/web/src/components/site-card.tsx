import type { DiscoverSite } from '@tela/db/queries'
import { languageBadge } from '@tela/shared'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { toggleSubscriptionAction } from '@/app/discover/actions'
import { cadenceKey } from '@/lib/assets'
import { displayHost } from '@/lib/format'
import { SiteAvatar } from './site-avatar'

export async function SiteCard({
  site,
  signedIn,
  next,
}: {
  site: DiscoverSite
  signedIn: boolean
  next: string
}) {
  const t = await getTranslations('discover')
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-line bg-white p-5 animate-fade"
      data-testid="site-card"
      data-site-id={site.id}
    >
      <div className="flex items-center gap-3">
        <SiteAvatar id={site.id} title={site.title} faviconKey={site.faviconKey} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-medium">
            <Link href={`/s/${site.id}`} className="truncate text-ink hover:underline">
              {site.title}
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
          {t('readers', { n: site.readerCount })} · {t(`cadence.${cadenceKey(site.postsLast30d)}`)}
        </span>
        {site.feedId === null ? null : signedIn ? (
          <form action={toggleSubscriptionAction}>
            <input type="hidden" name="feedId" value={site.feedId} />
            <input type="hidden" name="subscribed" value={site.isSubscribed ? '1' : '0'} />
            <input type="hidden" name="next" value={next} />
            <button
              type="submit"
              data-testid="site-subscribe"
              aria-pressed={site.isSubscribed}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-all hover:brightness-95 ${
                site.isSubscribed
                  ? 'border-line bg-transparent text-ink-2'
                  : 'border-ink bg-ink text-paper'
              }`}
            >
              {site.isSubscribed ? t('subscribed') : t('subscribe')}
            </button>
          </form>
        ) : (
          <Link
            href={`/login?next=${encodeURIComponent(next)}`}
            className="rounded-full border border-ink bg-ink px-3.5 py-1.5 text-[13px] font-medium text-paper hover:no-underline"
          >
            {t('subscribe')}
          </Link>
        )}
      </div>
    </div>
  )
}
