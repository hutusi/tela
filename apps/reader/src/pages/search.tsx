import { languageBadge } from '@tela/shared'
import type { ArticleRow } from '@tela/sync'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { LoadFailed } from '../components/load-failed'
import { SearchField } from '../components/search-field'
import { SiteAvatar } from '../components/site-avatar'
import { SiteCard, type SiteCardData } from '../components/site-card'
import { displayHost, relativeTime } from '../lib/format'
import { readingHref } from '../lib/href'
import { useMemberControls } from '../lib/member'
import { readingPrefsOf } from '../lib/prefs'
import { type ArticleHit, hitTitles, mergeHits, normalizeQuery, searchLocal } from '../lib/search'
import { useTitle } from '../lib/title'
import { BELOW_MD, useMediaQuery } from '../lib/use-media'
import { api } from '../store/api'
import { useNow, useReadingLang, useStore, useTables } from '../store/hooks'
import { feedTitle } from '../store/selectors'
import { useUi } from '../ui'
import type { MemberControls } from '../views/types'

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
  // The query whose search of Tela did not come back (offline, an error): the device's own hits
  // still show, and Try again asks once more.
  const [failed, setFailed] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const phone = useMediaQuery(BELOW_MD)
  useTitle(t('title'))

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Try again
  useEffect(() => {
    if (!query) return
    const controller = new AbortController()
    const q = new URLSearchParams({ q: query, lang: readingLang })
    setFailed(null)
    api(`/api/v1/search?${q}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`search: ${res.status}`)
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
      .catch(() => {
        if (!controller.signal.aborted) setFailed(query)
      })
    return () => controller.abort()
  }, [query, readingLang, store, attempt])

  const local = useMemo(() => searchLocal(tables, query, readingLang), [tables, query, readingLang])
  const answered = remote?.query === query ? remote : null
  const hits = mergeHits(local, answered?.articles ?? [])
  const sites = answered?.sites ?? []
  const nothing = query !== '' && answered !== null && sites.length === 0 && hits.length === 0
  const here = `/search?q=${encodeURIComponent(query)}`

  return (
    <main className="mx-auto w-full max-w-[1120px] flex-1 px-4 pb-20 pt-10 animate-fade max-md:px-5 max-md:pt-[22px] md:px-12">
      {/* The header's field only appears at xl. Below that its search link leads here, so the
          page has to carry the input or there is no way to run a search at all. On a phone it
          comes first, above what it searched for (Tela Mobile 15), since there it is what the
          page is for; from md it sits under the heading and the hint, as it always has. */}
      <div className="flex flex-col">
        <SearchField
          query={query}
          testId="search-page-input"
          glyphClassName="max-md:size-[15px]"
          className="mb-5 flex w-full max-w-[520px] items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 text-[15px] text-muted focus-within:border-muted max-md:py-[11px] md:order-last md:mb-8 xl:hidden"
        />
        <h1 className="mb-2 font-serif text-[34px] font-medium leading-tight tracking-tight [overflow-wrap:anywhere] max-md:mb-1 max-md:text-[28px] max-md:leading-[1.15]">
          {query ? t('resultsFor', { query }) : t('title')}
        </h1>
        <p className="mb-6 text-[15px] text-ink-2 max-md:mb-[22px] max-md:text-[13px] max-md:leading-[1.45] max-md:text-muted">
          {t('hint')}
        </p>
      </div>

      {nothing ? (
        <p className="text-muted" data-testid="search-empty">
          {t('none', { query })}
        </p>
      ) : null}

      {query !== '' && answered === null && failed === query ? (
        <LoadFailed onRetry={() => setAttempt((n) => n + 1)} className="mb-10 py-6" />
      ) : null}

      {sites.length > 0 ? (
        <section className="mb-12 max-md:mb-[26px]">
          <h2 className="mb-4 font-serif text-[22px] font-medium max-md:mb-3 max-md:text-[21px]">
            {t('sites')}
          </h2>
          {/* One or the other, not both with one hidden: each has a Subscribe of its own. */}
          {phone ? (
            <div className="flex flex-col gap-2.5" data-testid="search-sites">
              {sites.map((site) => (
                <SiteRow key={site.id} site={site} member={member} next={here} />
              ))}
            </div>
          ) : (
            <div
              className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]"
              data-testid="search-sites"
            >
              {sites.map((site) => (
                <SiteCard key={site.id} site={site} member={member} next={here} />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {query ? (
        <section>
          <h2 className="mb-2 font-serif text-[22px] font-medium max-md:mb-1 max-md:text-[21px]">
            {t('articles')}
          </h2>
          {hits.length === 0 ? (
            answered ? (
              <p className="text-[13.5px] text-muted">{t('noArticles')}</p>
            ) : null
          ) : (
            <div className="flex flex-col" data-testid="search-articles">
              {hits.map((hit) => {
                const a = hit.article
                const { main, mainLang, secondary, secondaryLang, badge } = hitTitles(
                  hit,
                  query,
                  readingLang,
                  never,
                )
                return (
                  <Link
                    key={a.id}
                    to={readingHref({ feedId: a.feedId, articleId: a.id })}
                    className="flex flex-col gap-1 border-line py-3.5 text-ink hover:bg-hover hover:no-underline max-md:border-b md:border-t"
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
                    <span
                      lang={mainLang ?? undefined}
                      className="font-serif text-[18px] leading-snug max-md:leading-[1.3]"
                      data-testid="hit-title"
                    >
                      {main}
                    </span>
                    {secondary !== null ? (
                      <span
                        lang={secondaryLang ?? undefined}
                        className="text-[13px] text-ink-2 max-md:-mt-0.5"
                        data-testid="hit-secondary"
                      >
                        {secondary}
                      </span>
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

/** Subscribe outlined in ink, Subscribed in the quieter thumb line, as v5 draws a row of blogs. */
const SUBSCRIBE =
  'shrink-0 cursor-pointer whitespace-nowrap rounded-full border bg-transparent px-3.5 py-1.5 text-[13px] font-medium transition-colors hover:bg-hover'

/**
 * A blog on a phone (Tela Mobile 15): a surface card one line tall, the host and its readers
 * beneath the name and Subscribe at the end, where Discover's card would take three lines of
 * description and its latest post. Built here, not as a variant of `SiteCard`, which the edge
 * renders for Discover with no JavaScript to choose between them. Its test ids are the card's, so
 * a spec finds a blog in search at any width.
 */
function SiteRow({
  site,
  member,
  next,
}: {
  site: SiteCardData
  member: MemberControls | undefined
  next: string
}) {
  const t = useTranslations('discover')
  const title = site.title ?? displayHost(site.homeUrl)
  const host = displayHost(site.homeUrl)
  const subscribed = site.feedId !== null && member?.isSubscribed(site.feedId) === true
  return (
    <div
      className="flex min-w-0 items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3.5"
      data-testid="site-card"
      data-site-id={site.id}
    >
      <SiteAvatar
        id={site.id}
        title={title}
        faviconKey={site.faviconKey}
        size={36}
        radius={9}
        className="!text-[15px]"
      />
      <div className="min-w-0 flex-1">
        <Link to={`/s/${site.id}`} className="block truncate font-medium text-ink hover:underline">
          {title}
        </Link>
        <div className="truncate text-[12.5px] text-muted">
          {/* Kept back below three readers (ADR 0041): then the host stands alone. */}
          {site.readerCount === null ? host : `${host} · ${t('readers', { n: site.readerCount })}`}
        </div>
      </div>
      {site.feedId === null ? null : member ? (
        <button
          type="button"
          onClick={() => site.feedId !== null && member.toggle(site.feedId, subscribed)}
          aria-pressed={subscribed}
          className={`${SUBSCRIBE} ${subscribed ? 'border-thumb text-ink-2' : 'border-ink text-ink'}`}
          data-testid="site-subscribe"
        >
          {subscribed ? t('subscribed') : t('subscribe')}
        </button>
      ) : (
        <Link
          to={`/login?next=${encodeURIComponent(next)}`}
          className={`${SUBSCRIBE} border-ink text-ink hover:no-underline`}
        >
          {t('subscribe')}
        </Link>
      )}
    </div>
  )
}
