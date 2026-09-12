import { getPublicProfile } from '@tela/db/queries'
import { languageBadge } from '@tela/shared'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { AppHeader } from '@/components/app-header'
import { SiteAvatar } from '@/components/site-avatar'
import { displayHost, relativeTime } from '@/lib/format'
import { getDb } from '@/lib/platform/db'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ handle: string }> }

/** /@handle: the segment is the literal "@handle"; anything else is not a profile. */
function handleFrom(segment: string): string | null {
  const decoded = decodeURIComponent(segment)
  return decoded.startsWith('@') ? decoded.slice(1).toLowerCase() : null
}

export async function generateMetadata({ params }: Props) {
  const handle = handleFrom((await params).handle)
  return { title: handle ? `@${handle}` : 'Not found' }
}

export default async function ProfilePage({ params }: Props) {
  const handle = handleFrom((await params).handle)
  if (!handle) notFound()
  const profile = await getPublicProfile(await getDb(), handle)
  if (!profile) notFound()
  const [t, locale] = await Promise.all([getTranslations('profile'), getLocale()])
  const name = profile.profile.displayName ?? `@${profile.profile.handle}`

  return (
    <>
      <AppHeader />
      <main
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-8 py-12 animate-fade"
        data-testid="profile-page"
      >
        <header className="flex items-start gap-5">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-accent font-serif text-2xl font-semibold text-white">
            {name.replace(/^@/, '').charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
              {name}
            </h1>
            <div className="mt-1 text-[13px] text-muted">
              @{profile.profile.handle} ·{' '}
              {t('memberSince', { when: relativeTime(profile.profile.createdAt, locale) })}
            </div>
            {profile.profile.bio ? (
              <p className="mt-3 max-w-xl font-serif text-[18px] leading-[1.4] text-body">
                {profile.profile.bio}
              </p>
            ) : null}
          </div>
        </header>

        {profile.claimedSites.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="font-serif text-[22px] font-medium">{t('writes')}</h2>
            <ul className="m-0 flex list-none flex-wrap gap-3 p-0">
              {profile.claimedSites.map((site) => (
                <li key={site.id}>
                  <Link
                    href={`/s/${site.id}`}
                    className="flex items-center gap-2.5 rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink hover:border-ink hover:no-underline"
                  >
                    <SiteAvatar
                      id={site.id}
                      title={site.title ?? site.homeUrl}
                      faviconKey={site.faviconKey}
                      size={28}
                    />
                    <span className="font-medium">{site.title ?? displayHost(site.homeUrl)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="flex flex-col gap-3" data-testid="profile-recommendations">
          <h2 className="font-serif text-[22px] font-medium">{t('recommendations')}</h2>
          {profile.recommendations.length === 0 ? (
            <p className="text-muted">{t('noRecommendations')}</p>
          ) : null}
          {profile.recommendations.map((r) => (
            <article key={r.id} className="rounded-xl border border-line bg-white p-4">
              <Link
                href={`/reading?article=${r.article.id}`}
                className="font-serif text-[19px] font-medium leading-tight text-ink hover:underline"
              >
                {r.article.title}
              </Link>
              <div className="mt-1 text-[12.5px] text-muted">
                <Link href={`/s/${r.site.id}`}>{r.site.title ?? displayHost(r.site.homeUrl)}</Link>
                {r.article.sourceLang ? ` · ${languageBadge(r.article.sourceLang)}` : ''}
                {` · ${relativeTime(r.createdAt, locale)}`}
              </div>
              {r.note ? (
                <p className="mt-2 font-serif text-[17px] leading-[1.45] text-body">“{r.note}”</p>
              ) : null}
            </article>
          ))}
        </section>

        {profile.subscriptions ? (
          <section className="flex flex-col gap-3" data-testid="profile-subscriptions">
            <h2 className="font-serif text-[22px] font-medium">{t('reads')}</h2>
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {profile.subscriptions.map((s) => (
                <li key={s.feedId}>
                  <Link
                    href={`/s/${s.siteId}`}
                    className="flex items-center gap-2 rounded-full border border-line bg-white py-1 pl-1 pr-3 text-[13px] text-ink hover:border-ink hover:no-underline"
                  >
                    <SiteAvatar id={s.siteId} title={s.title} faviconKey={s.faviconKey} size={22} />
                    {s.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </>
  )
}
