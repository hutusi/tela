import { languageBadge } from '@tela/shared'
import type { ArticleRow } from '@tela/sync'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { SearchField } from '../components/search-field'
import { SiteCard, type SiteCardData } from '../components/site-card'
import { relativeTime } from '../lib/format'
import { readingHref } from '../lib/href'
import { useMemberControls } from '../lib/member'
import { readingPrefsOf } from '../lib/prefs'
import { type ArticleHit, hitTitles, mergeHits, normalizeQuery, searchLocal } from '../lib/search'
import { useTitle } from '../lib/title'
import { api } from '../store/api'
import { useNow, useReadingLang, useStore, useTables } from '../store/hooks'
import { feedTitle } from '../store/selectors'
import { useUi } from '../ui'

type Remote = { query: string; sites: SiteCardData[]; articles: ArticleHit[] }

export function SearchPage() {
  const t = useTranslations('search')
  const [search] = useSearchParams()
  const query = normalizeQuery(search.get('q'))
  const tables = useTables()
  const { store } = useStore()
  const { locale } = useUi()
  const readingLang = useReadingLang(locale)
  const now = useNow()
  const member = useMemberControls()
  const never = readingPrefsOf(tables).never
  const [remote, setRemote] = useState<Remote | null>(null)
  useTitle(t('title'))

  useEffect(() => {
    if (!query) return
    const controller = new AbortController()
    const q = new URLSearchParams({ q: query, lang: readingLang })
    api(`/api/v1/search?${q}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const body = (await res.json()) as {
          sites: SiteCardData[]
          articles: (ArticleRow & { translatedTitle: string | null })[]
        }
        const articles = body.articles.map(({ translatedTitle, ...article }) => ({
          article,
          translatedTitle,
        }))
        // Older than the device holds, some of them: kept for this visit so the reader opens them.
        store.remember(articles.map((h) => h.article))
        setRemote({ query, sites: body.sites, articles })
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [query, readingLang, store])

  const local = useMemo(() => searchLocal(tables, query, readingLang), [tables, query, readingLang])
  const answered = remote?.query === query ? remote : null
  const hits = mergeHits(local, answered?.articles ?? [])
  const sites = answered?.sites ?? []
  const nothing = query !== '' && answered !== null && sites.length === 0 && hits.length === 0
  const here = `/search?q=${encodeURIComponent(query)}`

  return (
    <main className="mx-auto w-full max-w-[1120px] flex-1 px-4 pb-20 pt-10 animate-fade md:px-12">
      <h1 className="mb-2 font-serif text-[34px] font-medium leading-tight tracking-tight">
        {query ? t('resultsFor', { query }) : t('title')}
      </h1>
      <p className="mb-6 text-[15px] text-ink-2">{t('hint')}</p>

      {/* The header's field only appears at xl. Below that its search link leads here, so the
          page has to carry the input or there is no way to run a search at all. */}
      <SearchField
        key={query}
        query={query}
        testId="search-page-input"
        className="mb-8 flex w-full max-w-[520px] items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 text-[15px] text-muted focus-within:border-muted xl:hidden"
      />

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
              <SiteCard key={site.id} site={site} member={member} next={here} />
            ))}
          </div>
        </section>
      ) : null}

      {query ? (
        <section>
          <h2 className="mb-2 font-serif text-[22px] font-medium">{t('articles')}</h2>
          {hits.length === 0 ? (
            answered ? (
              <p className="text-[13.5px] text-muted">{t('noArticles')}</p>
            ) : null
          ) : (
            <div className="flex flex-col" data-testid="search-articles">
              {hits.map((hit) => {
                const a = hit.article
                const { main, secondary, badge } = hitTitles(hit, query, readingLang, never)
                return (
                  <Link
                    key={a.id}
                    to={readingHref({ feedId: a.feedId, articleId: a.id })}
                    className="flex flex-col gap-1 border-t border-line py-3.5 text-ink hover:bg-hover hover:no-underline"
                    data-testid="article-hit"
                  >
                    <span className="flex items-center gap-2 text-xs text-muted">
                      <span>{feedTitle(tables, a.feedId)}</span>
                      {badge ? (
                        <span className="rounded border border-line px-1.5 py-px text-[10.5px] uppercase tracking-wide">
                          {languageBadge(a.sourceLang ?? '')} → {languageBadge(readingLang)}
                        </span>
                      ) : null}
                      <span>{relativeTime(a.publishedAt ?? a.fetchedAt, locale, now)}</span>
                    </span>
                    <span className="font-serif text-[18px] leading-snug">{main}</span>
                    {secondary !== null ? (
                      <span className="text-[13px] text-ink-2">{secondary}</span>
                    ) : null}
                  </Link>
                )
              })}
            </div>
          )}
        </section>
      ) : null}
    </main>
  )
}
