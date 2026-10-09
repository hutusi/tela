/** Discover (`/discover`): listed blogs by topic and language. Rendered by the SPA and the edge. */
import { asLabel, LANGUAGE_NAMES, TOPICS, type UiLocale } from '@tela/shared'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { SiteCard } from '../components/site-card'
import { type DiscoverParams, discoverHref } from '../lib/discover-href'
import type { DiscoverData, MemberControls } from './types'

const chip = (on: boolean) =>
  `rounded-full border px-3.5 py-1.5 text-[13px] hover:no-underline ${
    on ? 'border-ink bg-ink text-paper' : 'border-line text-ink-2 hover:border-ink'
  }`

const menuItem = (on: boolean) =>
  `flex justify-between gap-3 rounded-md px-2.5 py-[7px] text-[13px] text-ink hover:bg-hover hover:no-underline ${on ? 'bg-hover' : ''}`

export function DiscoverView({
  data,
  params,
  member,
  locale,
}: {
  data: DiscoverData | null
  params: DiscoverParams
  member?: MemberControls | undefined
  locale: string
}) {
  const t = useTranslations('discover')
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  // The menu's value and items are labels: "Japonais", where a French sentence says "japonais".
  const label = (tag: string) => asLabel(names[tag] ?? tag, locale)
  const here = discoverHref(params)
  const langLabel = params.lang ? label(params.lang) : t('allLanguages')
  const languages = data?.languages ?? []
  const pages =
    data?.total !== undefined && data.pageSize ? Math.ceil(data.total / data.pageSize) : 1

  return (
    <main className="mx-auto w-full max-w-[1120px] flex-1 px-4 pb-20 pt-10 animate-fade md:px-12">
      <div className="mb-9 max-w-[620px]">
        <h1 className="mb-2.5 font-serif text-[40px] font-medium leading-[1.1] tracking-tight">
          {t('title')}
        </h1>
        <p className="m-0 text-base leading-normal text-ink-2">{t('intro')}</p>
      </div>

      <div className="mb-7 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-2" data-testid="topic-chips">
          <Link to={discoverHref({ lang: params.lang })} className={chip(params.topic === null)}>
            {t('allTopics')}
          </Link>
          {TOPICS.map((topic) => (
            <Link
              key={topic}
              to={discoverHref({ topic: params.topic === topic ? null : topic, lang: params.lang })}
              className={chip(params.topic === topic)}
            >
              {t(`topics.${topic}`)}
            </Link>
          ))}
        </div>
        <div className="flex-1" />
        {/* A <details>, so the menu works in the edge-rendered page before any script runs. */}
        <details className="relative" data-testid="discover-language">
          <summary
            className={`flex cursor-pointer list-none items-center gap-1.5 whitespace-nowrap rounded-full border bg-surface px-3 py-1.5 text-[13px] font-medium hover:border-muted ${
              params.lang ? 'border-ink' : 'border-line'
            }`}
          >
            <span className="font-normal text-muted">{t('language')}</span>
            {langLabel}
            <span className="text-[10px] text-muted">▾</span>
          </summary>
          <div className="absolute right-0 top-[calc(100%+6px)] z-[4] flex min-w-[180px] flex-col rounded-[10px] border border-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,.08)] animate-fade">
            <Link
              to={discoverHref({ topic: params.topic })}
              className={menuItem(params.lang === null)}
            >
              <span>{t('allLanguages')}</span>
              <span className="text-xs text-muted">
                {languages.reduce((n, l) => n + l.count, 0)}
              </span>
            </Link>
            {languages.map((l) => (
              <Link
                key={l.lang}
                to={discoverHref({ topic: params.topic, lang: l.lang })}
                className={menuItem(params.lang === l.lang)}
              >
                <span>{label(l.lang)}</span>
                <span className="text-xs text-muted">{l.count}</span>
              </Link>
            ))}
          </div>
        </details>
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
            <Link to={discoverHref({ ...params, page: params.page - 1 })} className={chip(false)}>
              ← {t('pager.previous')}
            </Link>
          ) : null}
          <span className="text-muted">{t('pager.page', { page: params.page, pages })}</span>
          {params.page < pages ? (
            <Link to={discoverHref({ ...params, page: params.page + 1 })} className={chip(false)}>
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
    </main>
  )
}
