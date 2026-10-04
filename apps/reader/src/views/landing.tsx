/**
 * The front page (`/`, ADR 0035): how many blogs Tela gathers, this week's edition of them, and
 * the doors in. Pure, rendered by the SPA and by the edge for visitors: nothing here reads
 * `window` or `document`, and the root does not fade in, since the edge's copy is already on
 * screen when the SPA replaces it. Only the edition waits for data; the rest is copy.
 *
 * The layout is the design's (Tela Landing, 2A Night / 2B Day; DESIGN.md): a two-column hero, an
 * uppercase strip over the edition, bordered cards three to a row with the lead across two, and a
 * full-width writers strip.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { type DoorRequest, opensSheet, useFrontDoor } from '../components/front-door'
import { SiteFooter } from '../components/site-footer'
import { bylineName, editionTitles, frontHref, pickLead, type TitlesMode } from '../lib/edition'
import { displayHost, relativeTime, swatchColor } from '../lib/format'
import { nameIn } from '../lib/language-name'
import { PostLink } from './post-link'
import type { FrontData, FrontPost, MemberControls } from './types'

const accent = (chunks: React.ReactNode) => <em className="font-normal text-accent">{chunks}</em>

/** The hero and the writers strip: the headline's column, then the one beside it, from `lg`. */
const SPLIT = 'grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16'

/** A link above the card's own: the card is one link to the post, laid over all of it. */
const ABOVE = 'relative z-[1]'

/**
 * The strip's date: "Thursday, 1 October" in English, day before month as the design sets it,
 * and the locale's own order otherwise ("10月1日星期四").
 */
function stripDate(now: number, locale: string): string {
  const date = new Date(now)
  if (locale.startsWith('en')) {
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(date)
    const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' }).format(date)
    return `${weekday}, ${day}`
  }
  return new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' }).format(
    date,
  )
}

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
  // What the strip says of the edition: nothing for an empty one, rather than "the latest from 0
  // blogs" beside "No posts yet".
  const span =
    posts.length === 0
      ? null
      : data?.edition.span === 'week'
        ? t('week', { blogs: data.week.blogs, languages: data.week.languages })
        : t('latest', { n: posts.length })

  return (
    <>
      {/* No slanted Chinese: an italic span or title in a script with no italic face stays upright,
          and its Latin keeps EB Garamond's own italic. */}
      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 pb-14 leading-[1.2] [font-synthesis-style:none] md:px-14">
        <section className={`${SPLIT} items-end gap-8 pt-12 pb-10 md:pt-20 md:pb-14`}>
          <h1 className="m-0 font-serif text-[44px] leading-none font-medium tracking-[-0.025em] text-balance break-keep md:text-[64px] lg:text-[80px]">
            {/* A count only once there is one: "a confluence of 0 blogs" is no welcome. */}
            {data && data.counts.blogs > 0
              ? t.rich('hero', { count: data.counts.blogs, em: accent })
              : t.rich('heroPlain', { em: accent })}
          </h1>
          <div className="flex flex-col gap-6 lg:pb-2">
            <p className="m-0 text-[17px] leading-[1.55] text-pretty text-ink-2 md:text-[18px]">
              {t('intro')}
            </p>
            <div className="flex flex-wrap items-center gap-2.5">
              <Link
                to="/join"
                onClick={opens({ mode: 'join' })}
                className="rounded-full bg-primary px-[26px] py-[13px] text-[15px] font-semibold text-on-primary hover:no-underline hover:brightness-110"
                data-testid="front-join"
              >
                {t('join')}
              </Link>
              <Link
                to="/login"
                onClick={opens({ mode: 'login' })}
                className="rounded-full border border-thumb px-[22px] py-[13px] text-[15px] font-medium text-ink hover:border-ink hover:no-underline"
                data-testid="front-login"
              >
                {t('logIn')}
              </Link>
            </div>
          </div>
        </section>

        <div
          className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line py-[18px]"
          data-testid="front-strip"
        >
          <p className="m-0 min-w-0 text-[11px] font-semibold tracking-[0.1em] text-muted uppercase">
            <span>{stripDate(now, locale)}</span>
            {span ? (
              <>
                <span aria-hidden="true"> · </span>
                {span}
              </>
            ) : !data && loading ? (
              <>
                <span aria-hidden="true"> · </span>
                <span className="inline-block h-2.5 w-48 animate-pulse rounded bg-hover align-middle" />
              </>
            ) : null}
          </p>
          <nav
            aria-label={t('titlesIn')}
            className="flex shrink-0 items-center gap-2.5 text-[13px] text-muted"
            data-testid="titles-toggle"
          >
            <span>{t('titlesIn')}</span>
            <span className="inline-flex rounded-full border border-thumb p-0.5">
              {(['original', 'translated'] as const).map((mode) => (
                <Link
                  key={mode}
                  to={frontHref(mode)}
                  aria-current={titles === mode ? 'page' : undefined}
                  data-testid={`titles-${mode}`}
                  className={`rounded-full px-3.5 py-[5px] font-medium hover:no-underline ${
                    titles === mode ? 'bg-ink text-paper' : 'text-ink-2 hover:text-ink'
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
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" aria-busy>
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className={`animate-pulse rounded-xl border border-line bg-hover ${
                    i === 0 ? 'h-[300px] md:col-span-2' : 'h-[210px]'
                  }`}
                />
              ))}
            </div>
          ) : null
        ) : posts.length === 0 ? (
          <p className="mt-2 leading-normal text-muted">{t('empty')}</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" data-testid="front-edition">
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
          className={`${SPLIT} mt-16 items-center gap-6 border-t border-line pt-10 pb-2`}
          data-testid="writers-strip"
        >
          <h2 className="m-0 font-serif text-[34px] leading-[1.05] font-medium tracking-[-0.015em] break-keep md:text-[44px]">
            {t('writers.title')}
          </h2>
          <div className="flex flex-col items-start gap-4">
            <p className="m-0 text-[16px] leading-[1.55] text-ink-2">{t('writers.intro')}</p>
            <Link
              to="/writers"
              className="rounded-full border border-thumb px-5 py-2.5 font-medium text-ink hover:border-ink hover:no-underline"
            >
              {t('writers.cta')}
            </Link>
          </div>
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
  // Who wrote it, beside the blog: the member who claimed it, linked to their card, or the feed's
  // own byline on the lead, which has the room.
  const author = lead ? bylineName(article.author, source) : null
  const byline = claimant ? (
    <Link
      to={`/@${claimant.handle}`}
      className={`${ABOVE} truncate text-ink-2 hover:text-ink hover:underline`}
    >
      {claimant.displayName ?? `@${claimant.handle}`}
    </Link>
  ) : author ? (
    <span className="truncate">{author}</span>
  ) : null
  const other = shown.small ? (
    <p
      lang={shown.small.lang}
      className="m-0 font-serif text-[16px] leading-[1.35] text-muted italic"
      data-testid="front-other-title"
    >
      {shown.small.text}
    </p>
  ) : null
  return (
    <article
      className={`relative flex min-w-0 flex-col rounded-xl border border-line bg-surface hover:border-muted ${
        lead
          ? 'gap-4 p-6 md:col-span-2 md:min-h-[300px] md:p-8'
          : 'gap-2.5 p-[22px] md:min-h-[210px]'
      }`}
      data-testid={lead ? 'front-lead' : 'front-post'}
    >
      <div
        className={`flex min-w-0 items-center gap-2 text-ink-2 ${lead ? 'text-[13px]' : 'text-[12.5px]'}`}
      >
        <span
          aria-hidden="true"
          className={`shrink-0 rounded-[3px] ${lead ? 'size-[11px]' : 'size-2.5'}`}
          style={{ background: swatchColor(article.feedId) }}
        />
        <Link
          to={`/s/${site.id}`}
          className={`${ABOVE} truncate font-medium text-ink hover:text-ink hover:underline`}
        >
          {source}
        </Link>
        {byline ? (
          <>
            <span aria-hidden="true">·</span>
            {byline}
          </>
        ) : null}
        {shown.label ? (
          <span
            className="ml-auto shrink-0 pl-2 text-[11px] font-semibold tracking-[0.08em] uppercase"
            data-testid="front-lang"
          >
            {shown.label}
          </span>
        ) : null}
      </div>
      <h2
        lang={shown.big.lang}
        className={`m-0 font-serif font-medium text-ink ${
          lead
            ? 'text-[34px] leading-[1.04] tracking-[-0.02em] text-balance md:text-[48px]'
            : 'mt-1 text-[28px] leading-[1.15] text-pretty'
        }`}
        data-testid="front-title"
      >
        <PostLink
          article={article}
          source={source}
          member={member}
          className="text-ink after:absolute after:inset-0 after:rounded-xl hover:text-ink hover:no-underline"
        >
          {shown.big.text}
        </PostLink>
      </h2>
      {lead ? null : other}
      {lead && shown.excerpt ? (
        <p
          lang={shown.excerpt.lang}
          className="m-0 line-clamp-4 max-w-[640px] font-serif text-[18px] leading-[1.45] text-pretty text-ink-2 md:text-[20px]"
        >
          {shown.excerpt.text}
        </p>
      ) : null}
      {lead ? other : null}
      <div
        className={`mt-auto flex items-center justify-between gap-3 text-muted ${
          lead ? 'text-[13px]' : 'text-[12.5px]'
        }`}
      >
        <span>
          {t('minutes', { n: article.readingMinutes || 1 })}
          <span aria-hidden="true"> · </span>
          {relativeTime(article.sortAt, locale, now)}
        </span>
        <span aria-hidden="true" className={lead ? 'font-medium text-accent' : undefined}>
          {lead ? t('readPost') : t('read')}
        </span>
      </div>
    </article>
  )
}
