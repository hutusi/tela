/**
 * The front page (`/`, ADR 0035): how many blogs Tela gathers, this week's edition of them, and
 * the doors in. Pure, rendered by the SPA and by the edge for visitors: nothing here reads
 * `window` or `document`, and the root does not fade in, since the edge's copy is already on
 * screen when the SPA replaces it. Only the edition waits for data; the rest is copy.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { type DoorRequest, opensSheet, useFrontDoor } from '../components/front-door'
import { SiteAvatar } from '../components/site-avatar'
import { SiteFooter } from '../components/site-footer'
import { editionTitles, frontHref, pickLead, type TitlesMode } from '../lib/edition'
import { displayHost, relativeTime } from '../lib/format'
import { nameIn } from '../lib/language-name'
import { PostLink } from './post-link'
import type { FrontData, FrontPost, MemberControls } from './types'

const accent = (chunks: React.ReactNode) => <em className="font-normal text-accent">{chunks}</em>

export function LandingView({
  data,
  loading,
  titles,
  reading,
  locale,
  now,
  member,
}: {
  /** Null while the edition is on its way, or when tela-api has none to give. */
  data: FrontData | null
  loading: boolean
  titles: TitlesMode
  /** The language translated titles are in: the reader's. */
  reading: string
  locale: string
  now: number
  member?: MemberControls | undefined
}) {
  const t = useTranslations('front')
  // The doors are links, so they work in the edge's page before any script runs; once the app
  // runs they open the header's sheet over the page, as the header's own Log in and Join do.
  const door = useFrontDoor()
  const opens = (request: DoorRequest) => (e: React.MouseEvent) => {
    if (!door || !opensSheet(e)) return
    e.preventDefault()
    door(request)
  }
  const posts = data?.edition.posts ?? []
  const lead = pickLead(posts)
  const rest = posts.filter((p) => p !== lead)
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(now))

  return (
    <>
      <main className="mx-auto w-full max-w-[1120px] flex-1 px-4 pt-12 pb-20 md:px-12 md:pt-20">
        <section className="max-w-[860px]">
          <h1 className="m-0 font-serif text-[42px] leading-[1.06] font-medium tracking-[-0.02em] md:text-[64px]">
            {data
              ? t.rich('hero', { count: data.counts.blogs, em: accent })
              : t.rich('heroPlain', { em: accent })}
          </h1>
          <p className="mt-5 mb-0 max-w-[620px] text-[17px] leading-relaxed text-ink-2">
            {t('intro')}
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              to="/join"
              onClick={opens({ mode: 'join' })}
              className="rounded-full bg-primary px-5 py-2.5 font-medium text-on-primary hover:no-underline hover:brightness-125"
              data-testid="front-join"
            >
              {t('join')}
            </Link>
            <Link
              to="/login"
              onClick={opens({ mode: 'login' })}
              className="rounded-full border border-line px-5 py-2.5 font-medium text-ink hover:border-ink hover:no-underline"
              data-testid="front-login"
            >
              {t('logIn')}
            </Link>
          </div>
        </section>

        <div
          className="mt-14 flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-line py-3 text-[13px]"
          data-testid="front-strip"
        >
          <p className="m-0 min-w-0 flex-1 text-ink-2">
            <span className="font-medium text-ink">{date}</span>
            <span aria-hidden="true"> · </span>
            {data ? (
              data.edition.span === 'week' ? (
                t('week', { blogs: data.week.blogs, languages: data.week.languages })
              ) : (
                t('latest', { n: posts.length })
              )
            ) : loading ? (
              <span className="inline-block h-3 w-48 animate-pulse rounded bg-hover align-middle" />
            ) : null}
          </p>
          <nav
            aria-label={t('titlesIn')}
            className="flex shrink-0 items-center gap-2"
            data-testid="titles-toggle"
          >
            <span className="text-muted">{t('titlesIn')}</span>
            <span className="inline-flex rounded-full bg-hover p-0.5">
              {(['original', 'translated'] as const).map((mode) => (
                <Link
                  key={mode}
                  to={frontHref(mode)}
                  aria-current={titles === mode ? 'page' : undefined}
                  data-testid={`titles-${mode}`}
                  className={`rounded-full px-3 py-1 font-medium hover:no-underline ${
                    titles === mode ? 'bg-surface text-ink shadow' : 'text-ink-2 hover:text-ink'
                  }`}
                >
                  {mode === 'original' ? t('original') : nameIn(reading, locale)}
                </Link>
              ))}
            </span>
          </nav>
        </div>

        {data === null ? (
          loading ? (
            <div className="mt-8 grid gap-x-10 gap-y-10 md:grid-cols-2 lg:grid-cols-3" aria-busy>
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className={`animate-pulse rounded-xl bg-hover ${i === 0 ? 'h-[220px] md:col-span-2' : 'h-[150px]'}`}
                />
              ))}
            </div>
          ) : null
        ) : posts.length === 0 ? (
          <p className="mt-8 text-muted">{t('empty')}</p>
        ) : (
          <div
            className="mt-8 grid gap-x-10 gap-y-10 md:grid-cols-2 lg:grid-cols-3"
            data-testid="front-edition"
          >
            {lead ? (
              <PostCard
                post={lead}
                lead
                titles={titles}
                reading={reading}
                locale={locale}
                now={now}
                member={member}
              />
            ) : null}
            {rest.map((post) => (
              <PostCard
                key={post.article.id}
                post={post}
                lead={false}
                titles={titles}
                reading={reading}
                locale={locale}
                now={now}
                member={member}
              />
            ))}
          </div>
        )}

        <section
          className="mt-16 flex flex-wrap items-center gap-6 rounded-xl border border-line bg-surface px-7 py-6"
          data-testid="writers-strip"
        >
          <div className="min-w-[240px] flex-1">
            <h2 className="m-0 mb-1 font-serif text-[24px] leading-tight font-medium">
              {t.rich('writers.title', { em: accent })}
            </h2>
            <p className="m-0 text-ink-2">{t('writers.intro')}</p>
          </div>
          <Link
            to="/writers"
            className="rounded-full border border-ink px-[18px] py-[9px] font-medium text-ink hover:bg-ink hover:text-paper hover:no-underline"
          >
            {t('writers.cta')}
          </Link>
        </section>
      </main>
      <SiteFooter year={new Date(now).getFullYear()} />
    </>
  )
}

function PostCard({
  post,
  lead,
  titles,
  reading,
  locale,
  now,
  member,
}: {
  post: FrontPost
  lead: boolean
  titles: TitlesMode
  reading: string
  locale: string
  now: number
  member: MemberControls | undefined
}) {
  const t = useTranslations('front')
  const { article, site, claimant } = post
  const shown = editionTitles(article, titles, reading, locale)
  const source = site.title ?? displayHost(site.homeUrl)
  return (
    <article
      className={`flex min-w-0 flex-col gap-2 ${lead ? 'md:col-span-2' : ''}`}
      data-testid={lead ? 'front-lead' : 'front-post'}
    >
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted">
        <SiteAvatar id={site.id} title={source} faviconKey={site.faviconKey} size={18} radius={4} />
        <Link
          to={`/s/${site.id}`}
          className="truncate font-medium text-ink-2 hover:text-ink hover:no-underline"
        >
          {source}
        </Link>
        {shown.label ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0" data-testid="front-lang">
              {shown.label}
            </span>
          </>
        ) : null}
      </div>
      <h2
        lang={shown.big.lang}
        className={`m-0 font-serif font-medium ${
          lead
            ? 'text-[30px] leading-[1.12] tracking-[-0.015em] md:text-[40px]'
            : 'text-[21px] leading-snug'
        }`}
        data-testid="front-title"
      >
        <PostLink
          article={article}
          source={source}
          member={member}
          className="text-ink hover:text-accent-strong hover:no-underline"
        >
          {shown.big.text}
        </PostLink>
      </h2>
      {shown.small ? (
        <p
          lang={shown.small.lang}
          className="m-0 text-[14px] leading-snug text-muted"
          data-testid="front-other-title"
        >
          {shown.small.text}
        </p>
      ) : null}
      {lead && shown.excerpt ? (
        <p
          lang={shown.excerpt.lang}
          className="m-0 mt-1 line-clamp-4 max-w-[680px] font-serif text-[18px] leading-relaxed text-ink-2"
        >
          {shown.excerpt.text}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-2 text-[12.5px] text-muted">
        <span>{relativeTime(article.sortAt, locale, now)}</span>
        <span aria-hidden="true">·</span>
        <span>{t('minutes', { n: article.readingMinutes || 1 })}</span>
        {claimant ? (
          <>
            <span aria-hidden="true">·</span>
            <Link
              to={`/@${claimant.handle}`}
              className="text-ink-2 hover:text-ink hover:no-underline"
            >
              {t('by', { name: claimant.displayName ?? `@${claimant.handle}` })}
            </Link>
          </>
        ) : null}
      </div>
    </article>
  )
}
