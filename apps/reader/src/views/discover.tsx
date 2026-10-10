/**
 * Discover's Blogs (`/discover/blogs`): listed blogs by topic and language, paged. Rendered by the
 * SPA and the edge. A directory, so the blogs the member reads stay on it, as "Subscribed".
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { chip, LanguageFilter, TopicChips } from '../components/discover-filters'
import { SiteCard } from '../components/site-card'
import { type BlogsParams, blogsHref } from '../lib/discover-href'
import { DiscoverFrame } from './discover-frame'
import type { DiscoverData, MemberControls } from './types'

export function DiscoverView({
  data,
  params,
  member,
  locale,
}: {
  data: DiscoverData | null
  params: BlogsParams
  member?: MemberControls | undefined
  locale: string
}) {
  const t = useTranslations('discover')
  const here = blogsHref(params)
  const pages =
    data?.total !== undefined && data.pageSize ? Math.ceil(data.total / data.pageSize) : 1

  return (
    <DiscoverFrame tab="blogs">
      <div className="mb-7 flex flex-wrap items-center gap-3">
        <TopicChips
          topic={params.topic}
          hrefOf={(topic) => blogsHref({ topic, lang: params.lang })}
        />
        <div className="flex-1" />
        <LanguageFilter
          lang={params.lang}
          languages={data?.languages ?? []}
          hrefOf={(lang) => blogsHref({ topic: params.topic, lang })}
          locale={locale}
        />
      </div>

      {data === null ? (
        <div
          className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4"
          aria-busy="true"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[190px] animate-pulse rounded-xl border border-line bg-surface"
            />
          ))}
        </div>
      ) : data.sites.length === 0 ? (
        <p className="text-muted">{t('empty')}</p>
      ) : (
        <div
          className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4"
          data-testid="site-grid"
        >
          {data.sites.map((site) => (
            <SiteCard key={site.id} site={site} member={member} next={here} />
          ))}
        </div>
      )}

      {pages > 1 && (
        <nav
          className="mt-8 flex items-center justify-center gap-5 text-[13px]"
          data-testid="discover-pager"
        >
          {params.page > 1 ? (
            <Link to={blogsHref({ ...params, page: params.page - 1 })} className={chip(false)}>
              ← {t('pager.previous')}
            </Link>
          ) : null}
          <span className="text-muted">{t('pager.page', { page: params.page, pages })}</span>
          {params.page < pages ? (
            <Link to={blogsHref({ ...params, page: params.page + 1 })} className={chip(false)}>
              {t('pager.next')} →
            </Link>
          ) : null}
        </nav>
      )}

      <div className="mt-12 flex flex-wrap items-center gap-6 rounded-xl border border-line px-7 py-6">
        <div className="min-w-[260px] flex-1">
          <div className="mb-1 font-serif text-[22px] font-medium">{t('claim.title')}</div>
          <div className="text-ink-2">{t('claim.intro')}</div>
        </div>
        <Link
          to="/claim"
          className="rounded-full border border-ink px-[18px] py-[9px] font-medium text-ink hover:bg-ink hover:text-paper hover:no-underline"
          data-testid="claim-cta"
        >
          {t('claim.cta')}
        </Link>
      </div>
    </DiscoverFrame>
  )
}
