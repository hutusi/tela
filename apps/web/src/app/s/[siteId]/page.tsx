import { getSitePage } from '@tela/db/queries'
import { languageBadge, TOPICS } from '@tela/shared'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { toggleSubscriptionAction } from '@/app/discover/actions'
import { AppHeader } from '@/components/app-header'
import { SiteAvatar } from '@/components/site-avatar'
import { getSessionUser } from '@/lib/auth'
import { displayHost, relativeTime } from '@/lib/format'
import { getDb } from '@/lib/platform/db'
import { setTopicsAction } from './actions'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ siteId: string }> }

export async function generateMetadata({ params }: Props) {
  const { siteId } = await params
  const page = await getSitePage(await getDb(), Number(siteId), null).catch(() => null)
  return { title: page?.site.title ?? 'Site' }
}

/** Public page for a blog: what it is, who reads it, and its latest posts. */
export default async function SitePage({ params }: Props) {
  const { siteId: raw } = await params
  const siteId = Number(raw)
  if (!Number.isInteger(siteId) || siteId <= 0) notFound()
  const user = await getSessionUser()
  const page = await getSitePage(await getDb(), siteId, user?.id ?? null)
  if (!page) notFound()
  const [t, td, locale] = await Promise.all([
    getTranslations('site'),
    getTranslations('discover'),
    getLocale(),
  ])
  const { site } = page
  const title = site.title ?? displayHost(site.homeUrl)
  const primary = page.feeds[0]
  const here = `/s/${siteId}`

  return (
    <>
      <AppHeader active="discover" />
      <main
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-8 py-12 animate-fade"
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
              {page.claimant ? (
                <span>{t('claimedBy', { handle: page.claimant.handle })}</span>
              ) : null}
            </div>
            {site.description ? (
              <p className="mt-3 max-w-xl font-serif text-[18px] leading-[1.4] text-body">
                {site.description}
              </p>
            ) : null}
            {site.topics.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {site.topics.map((topic) => (
                  <Link
                    key={topic}
                    href={`/discover?topic=${topic}`}
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
              user ? (
                <form action={toggleSubscriptionAction}>
                  <input type="hidden" name="feedId" value={primary.id} />
                  <input type="hidden" name="subscribed" value={primary.isSubscribed ? '1' : '0'} />
                  <input type="hidden" name="next" value={here} />
                  <button
                    type="submit"
                    data-testid="site-subscribe"
                    aria-pressed={primary.isSubscribed}
                    className={`rounded-full border px-4 py-2 text-[13px] font-medium ${
                      primary.isSubscribed
                        ? 'border-line text-ink-2'
                        : 'border-ink bg-ink text-paper'
                    }`}
                  >
                    {primary.isSubscribed ? td('subscribed') : td('subscribe')}
                  </button>
                </form>
              ) : (
                <Link
                  href={`/login?next=${encodeURIComponent(here)}`}
                  className="rounded-full border border-ink bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:no-underline"
                >
                  {td('subscribe')}
                </Link>
              )
            ) : null}
            {!site.claimedBy && user ? (
              <Link
                href={`/sites/${siteId}/claim`}
                className="text-[13px] text-muted hover:text-ink"
                data-testid="claim-link"
              >
                {t('claimLink')}
              </Link>
            ) : null}
          </div>
        </header>

        {page.isOwner ? (
          <form
            action={setTopicsAction}
            className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white p-4"
            data-testid="topics-form"
          >
            <input type="hidden" name="siteId" value={siteId} />
            <span className="mr-2 text-[13px] font-medium">{t('yourTopics')}</span>
            {TOPICS.map((topic) => (
              <label
                key={topic}
                className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12.5px]"
              >
                <input
                  type="checkbox"
                  name="topics"
                  value={topic}
                  defaultChecked={site.topics.includes(topic)}
                />
                {td(`topics.${topic}`)}
              </label>
            ))}
            <button
              type="submit"
              className="ml-auto rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-paper"
            >
              {t('saveTopics')}
            </button>
          </form>
        ) : null}

        <section>
          <h2 className="mb-3 font-serif text-[22px] font-medium">{t('latestPosts')}</h2>
          {page.articles.length === 0 ? (
            <p className="text-muted">{t('noPosts')}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col p-0" data-testid="site-articles">
              {page.articles.map((a) => (
                <li key={a.id} className="border-t border-line py-3">
                  <Link
                    href={`/reading?article=${a.id}`}
                    className="font-serif text-[19px] font-medium leading-tight text-ink hover:no-underline hover:underline"
                  >
                    {a.title}
                  </Link>
                  <div className="mt-1 text-[12.5px] text-muted">
                    {relativeTime(a.publishedAt ?? a.fetchedAt, locale)}
                    {a.sourceLang ? ` · ${languageBadge(a.sourceLang)}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  )
}
