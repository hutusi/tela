import { discoverLanguageCounts, listDiscoverSites } from '@tela/db/queries'
import { LANGUAGE_NAMES, TOPICS, type UiLocale } from '@tela/shared'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { AppHeader } from '@/components/app-header'
import { SiteCard } from '@/components/site-card'
import { getSessionUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'
import { discoverHref, parseDiscoverParams } from './href'

export const dynamic = 'force-dynamic'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export async function generateMetadata() {
  const t = await getTranslations('nav')
  return { title: t('discover') }
}

export default async function DiscoverPage({ searchParams }: Props) {
  const params = parseDiscoverParams(await searchParams)
  const [user, t, locale] = await Promise.all([
    getSessionUser(),
    getTranslations('discover'),
    getLocale(),
  ])
  const db = await getDb()
  const [sites, languages] = await Promise.all([
    listDiscoverSites(db, { topic: params.topic, lang: params.lang, userId: user?.id ?? null }),
    discoverLanguageCounts(db, params.topic),
  ])
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  const here = discoverHref(params)
  const langLabel = params.lang ? (names[params.lang] ?? params.lang) : t('allLanguages')

  return (
    <>
      <AppHeader active="discover" />
      <main className="mx-auto w-full max-w-[1120px] flex-1 px-12 pb-20 pt-10 animate-fade">
        <div className="mb-9 max-w-[620px]">
          <h1 className="mb-2.5 font-serif text-[40px] font-medium leading-[1.1] tracking-tight">
            {t('title')}
          </h1>
          <p className="m-0 text-base leading-normal text-ink-2">{t('intro')}</p>
        </div>

        <div className="mb-7 flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2" data-testid="topic-chips">
            <Link
              href={discoverHref({ lang: params.lang })}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] hover:no-underline ${
                params.topic === null
                  ? 'border-ink bg-ink text-paper'
                  : 'border-line text-ink-2 hover:border-ink'
              }`}
            >
              {t('allTopics')}
            </Link>
            {TOPICS.map((topic) => (
              <Link
                key={topic}
                href={discoverHref({
                  topic: params.topic === topic ? null : topic,
                  lang: params.lang,
                })}
                className={`rounded-full border px-3.5 py-1.5 text-[13px] hover:no-underline ${
                  params.topic === topic
                    ? 'border-ink bg-ink text-paper'
                    : 'border-line text-ink-2 hover:border-ink'
                }`}
              >
                {t(`topics.${topic}`)}
              </Link>
            ))}
          </div>
          <div className="flex-1" />
          <details className="relative" data-testid="language-menu">
            <summary
              className={`flex cursor-pointer list-none items-center gap-1.5 whitespace-nowrap rounded-full border bg-white px-3 py-1.5 text-[13px] font-medium hover:border-muted ${
                params.lang ? 'border-ink' : 'border-line'
              }`}
            >
              <span className="font-normal text-muted">{t('language')}</span>
              {langLabel}
              <span className="text-[10px] text-muted">▾</span>
            </summary>
            <div className="absolute right-0 top-[calc(100%+6px)] z-[4] flex min-w-[180px] flex-col rounded-[10px] border border-line bg-white p-1.5 shadow-[0_8px_24px_rgba(0,0,0,.08)] animate-fade">
              <Link
                href={discoverHref({ topic: params.topic })}
                className={`flex justify-between gap-3 rounded-md px-2.5 py-[7px] text-[13px] text-ink hover:bg-hover hover:no-underline ${params.lang === null ? 'bg-hover' : ''}`}
              >
                <span>{t('allLanguages')}</span>
                <span className="text-xs text-muted">
                  {languages.reduce((n, l) => n + l.count, 0)}
                </span>
              </Link>
              {languages.map((l) => (
                <Link
                  key={l.lang}
                  href={discoverHref({ topic: params.topic, lang: l.lang })}
                  className={`flex justify-between gap-3 rounded-md px-2.5 py-[7px] text-[13px] text-ink hover:bg-hover hover:no-underline ${params.lang === l.lang ? 'bg-hover' : ''}`}
                >
                  <span>{names[l.lang] ?? l.lang}</span>
                  <span className="text-xs text-muted">{l.count}</span>
                </Link>
              ))}
            </div>
          </details>
        </div>

        {sites.length === 0 ? (
          <p className="text-muted">{t('empty')}</p>
        ) : (
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4"
            data-testid="site-grid"
          >
            {sites.map((site) => (
              <SiteCard key={site.id} site={site} signedIn={user !== null} next={here} />
            ))}
          </div>
        )}

        <div className="mt-12 flex flex-wrap items-center gap-6 rounded-xl border border-line px-7 py-6">
          <div className="min-w-[260px] flex-1">
            <div className="mb-1 font-serif text-[22px] font-medium">{t('claim.title')}</div>
            <div className="text-ink-2">{t('claim.intro')}</div>
          </div>
          <Link
            href="/claim"
            className="rounded-full border border-ink px-[18px] py-[9px] font-medium text-ink hover:bg-ink hover:text-paper hover:no-underline"
            data-testid="claim-cta"
          >
            {t('claim.cta')}
          </Link>
        </div>
      </main>
    </>
  )
}
