import { listDiscoverSites, normalizeQuery, searchArticles } from '@tela/db/queries'
import { languageBadge } from '@tela/shared'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { readingHref } from '@/app/reading/href'
import { AppHeader } from '@/components/app-header'
import { showsTranslation } from '@/components/shows-translation'
import { SiteCard } from '@/components/site-card'
import { getSessionUser } from '@/lib/auth'
import { relativeTime } from '@/lib/format'
import { getDb } from '@/lib/platform/db'
import { getReadingLang } from '@/lib/reading'

export const dynamic = 'force-dynamic'

type Props = { searchParams: Promise<{ q?: string | string[] }> }

export async function generateMetadata() {
  const t = await getTranslations('search')
  return { title: t('title') }
}

export default async function SearchPage({ searchParams }: Props) {
  const raw = (await searchParams).q
  const query = normalizeQuery(Array.isArray(raw) ? raw[0] : raw)
  const [user, t, locale, readingLang] = await Promise.all([
    getSessionUser(),
    getTranslations('search'),
    getLocale(),
    getReadingLang(),
  ])
  const db = await getDb()
  const [sites, hits] = query
    ? await Promise.all([
        listDiscoverSites(db, {
          query,
          userId: user?.id ?? null,
          includeSubscribed: user !== null,
          limit: 12,
        }),
        user ? searchArticles(db, { userId: user.id, query, readingLang, limit: 30 }) : [],
      ])
    : [[], []]
  const here = `/search?q=${encodeURIComponent(query)}`
  const nothing = query && sites.length === 0 && hits.length === 0

  return (
    <>
      <AppHeader query={query} />
      <main className="mx-auto w-full max-w-[1120px] flex-1 px-12 pb-20 pt-10 animate-fade">
        <h1 className="mb-2 font-serif text-[34px] font-medium leading-tight tracking-tight">
          {query ? t('resultsFor', { query }) : t('title')}
        </h1>
        <p className="mb-8 text-[15px] text-ink-2">{t('hint')}</p>

        {nothing ? (
          <p className="text-muted" data-testid="search-empty">
            {t('none', { query })}
          </p>
        ) : null}

        {sites.length > 0 ? (
          <section className="mb-12">
            <h2 className="mb-4 font-serif text-[22px] font-medium">{t('sites')}</h2>
            <div
              className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]"
              data-testid="search-sites"
            >
              {sites.map((site) => (
                <SiteCard key={site.id} site={site} signedIn={user !== null} next={here} />
              ))}
            </div>
          </section>
        ) : null}

        {query && user ? (
          <section>
            <h2 className="mb-2 font-serif text-[22px] font-medium">{t('articles')}</h2>
            {hits.length === 0 ? (
              <p className="text-[13.5px] text-muted">{t('noArticles')}</p>
            ) : (
              <div className="flex flex-col" data-testid="search-articles">
                {hits.map((hit) => {
                  const showTranslation = showsTranslation(
                    hit.sourceLang,
                    readingLang,
                    hit.translatedTitle,
                  )
                  return (
                    <Link
                      key={hit.id}
                      href={readingHref({ feedId: hit.feedId, articleId: hit.id })}
                      className="flex flex-col gap-1 border-t border-line py-3.5 text-ink hover:bg-hover hover:no-underline"
                      data-testid="article-hit"
                    >
                      <span className="flex items-center gap-2 text-xs text-muted">
                        <span>{hit.siteTitle ?? hit.feedTitle}</span>
                        {showTranslation ? (
                          <span className="rounded border border-line px-1.5 py-px text-[10.5px] uppercase tracking-wide">
                            {languageBadge(hit.sourceLang ?? '')} → {languageBadge(readingLang)}
                          </span>
                        ) : null}
                        {hit.at ? <span>{relativeTime(hit.at, locale)}</span> : null}
                      </span>
                      <span className="font-serif text-[18px] leading-snug">
                        {showTranslation ? hit.translatedTitle : hit.title}
                      </span>
                      {showTranslation && hit.translatedTitle !== hit.title ? (
                        <span className="text-[13px] text-ink-2">{hit.title}</span>
                      ) : null}
                    </Link>
                  )
                })}
              </div>
            )}
          </section>
        ) : query ? (
          <p className="text-[13.5px] text-muted">{t('signInForArticles')}</p>
        ) : null}
      </main>
    </>
  )
}
