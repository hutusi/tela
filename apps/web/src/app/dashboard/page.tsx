import { getDashboard } from '@tela/db/queries'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { AppHeader } from '@/components/app-header'
import { SiteAvatar } from '@/components/site-avatar'
import { requireUser } from '@/lib/auth'
import { displayHost, relativeTime } from '@/lib/format'
import { getDb } from '@/lib/platform/db'
import { setTranslationOptOutAction } from './actions'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('dashboard')
  return { title: t('title') }
}

/** What an author sees about their claimed sites. */
export default async function DashboardPage() {
  const user = await requireUser('/dashboard')
  const [dash, t, td, locale] = await Promise.all([
    getDashboard(await getDb(), user.id),
    getTranslations('dashboard'),
    getTranslations('discover'),
    getLocale(),
  ])
  return (
    <>
      <AppHeader active="dashboard" />
      <main
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-8 py-12 animate-fade"
        data-testid="dashboard"
      >
        <div>
          <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
            {t('title')}
          </h1>
          <p className="mt-2 text-[15px] text-ink-2">{t('intro')}</p>
        </div>

        {dash.sites.length === 0 ? (
          <div className="rounded-xl border border-line bg-white p-6">
            <p className="mb-3 text-ink-2">{t('noSites')}</p>
            <Link
              href="/claim"
              className="inline-block rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:no-underline"
            >
              {td('claim.cta')}
            </Link>
          </div>
        ) : null}

        {dash.sites.map((site) => (
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
                  <Link href={`/s/${site.id}`} className="text-ink hover:underline">
                    {site.title ?? displayHost(site.homeUrl)}
                  </Link>
                </h2>
                <div className="text-[13px] text-muted">
                  {displayHost(site.homeUrl)} · {td('readers', { n: site.readerCount })} ·{' '}
                  {t(`listing.${site.listing}`)}
                </div>
              </div>
              <form
                action={setTranslationOptOutAction}
                className="flex items-center gap-2 text-[13px]"
              >
                <input type="hidden" name="siteId" value={site.id} />
                <input type="hidden" name="optOut" value={site.translationOptOut ? '0' : '1'} />
                <button
                  type="submit"
                  className="rounded-full border border-line px-3 py-1.5 hover:border-ink"
                  data-testid="translation-optout"
                >
                  {site.translationOptOut ? t('allowTranslation') : t('optOutTranslation')}
                </button>
              </form>
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
                      <Link
                        href={`/reading?article=${post.id}`}
                        className="font-serif text-[17px] text-ink hover:underline"
                      >
                        {post.title}
                      </Link>
                      <div className="text-[12px] text-muted">
                        {relativeTime(post.publishedAt, locale)}
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

        {dash.sites.length > 0 ? (
          <section className="flex flex-col gap-3" data-testid="dashboard-notes">
            <h2 className="font-serif text-[22px] font-medium">{t('notes')}</h2>
            {dash.notes.length === 0 ? <p className="text-muted">{t('noNotes')}</p> : null}
            {dash.notes.map((n) => (
              <blockquote key={n.id} className="m-0 rounded-xl border border-line bg-white p-4">
                <p className="m-0 font-serif text-[17px] leading-[1.45] text-body">{n.note}</p>
                <footer className="mt-2 text-[12.5px] text-muted">
                  <Link href={`/@${n.recommender.handle}`}>@{n.recommender.handle}</Link>
                  {' · '}
                  <Link href={`/reading?article=${n.article.id}`}>{n.article.title}</Link>
                  {' · '}
                  {relativeTime(n.createdAt, locale)}
                </footer>
              </blockquote>
            ))}
          </section>
        ) : null}
      </main>
    </>
  )
}
