/**
 * The front page (`/`, ADR 0035): how many blogs Tela gathers, this week's edition of them, and
 * the doors in. Pure, rendered by the SPA and by the edge for visitors: nothing here reads
 * `window` or `document`, and the root does not fade in, since the edge's copy is already on
 * screen when the SPA replaces it. Only the edition waits for data; the rest is copy.
 *
 * The layout is Claude Design's Tela Public (ADR 0070, DESIGN.md): the date over a large serif
 * title, then the edition as type under an ink rule, the lead beside a column of three with the
 * rest in columns under both, and a line for writers.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { type DoorRequest, opensSheet, useFrontDoor } from '../components/front-door'
import { SiteFooter } from '../components/site-footer'
import { bylineName, editionTitles, frontHref, pickLead, type TitlesMode } from '../lib/edition'
import { blogAddress, relativeTime } from '../lib/format'
import { nameIn } from '../lib/language-name'
import { PostLink } from './post-link'
import {
  BODY,
  HEAD,
  LINK,
  META,
  PAGE,
  PILL,
  PILL_QUIET,
  POST_TITLE,
  QUIET_LINK,
  STANDFIRST,
  TEXT_LINK,
  TITLE,
} from './public-type'
import type { FrontData, FrontPost, MemberControls } from './types'

/** The rule between the side column's posts. */
const RULE = 'h-px bg-line'

/** A post's place in the edition: the lead, the column beside it, or the columns under both. */
type Place = 'lead' | 'side' | 'rest'

/** How many posts the column beside the lead takes; the rest go into the columns under both. */
const SIDE = 3

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
  const side = rest.slice(0, SIDE)
  const under = rest.slice(SIDE)
  // What the edition's head says of it: nothing for an empty one, rather than "the latest from 0
  // blogs" beside "No posts yet".
  const span =
    posts.length === 0
      ? null
      : data?.edition.span === 'week'
        ? t('week', { blogs: data.week.blogs, languages: data.week.languages })
        : t('latest', { n: posts.length })
  const post = (p: FrontPost, place: Place) => (
    <Post
      key={p.article.id}
      post={p}
      place={place}
      titles={titles}
      reading={reading}
      locale={locale}
      now={now}
      member={member}
    />
  )

  return (
    <>
      {/* No slanted Chinese: a title in a script with no italic face stays upright. */}
      <main
        className={`${PAGE} pt-[clamp(28px,5vw,60px)] pb-[clamp(72px,10vw,120px)] [font-synthesis-style:none]`}
      >
        <p className={`m-0 ${META}`} data-testid="front-date">
          {stripDate(now, locale)}
        </p>
        <h1
          className={`${TITLE} mt-3 max-w-[15em] [font-size:calc(clamp(38px,6.2vw,68px)*var(--hs))]`}
        >
          {/* A count only once there is one: "a confluence of 0 blogs" is no welcome. */}
          {data && data.counts.blogs > 0 ? t('hero', { count: data.counts.blogs }) : t('heroPlain')}
        </h1>
        <p
          className={`${STANDFIRST} mt-[18px] max-w-[34em] text-ink-2 [font-size:calc(clamp(18px,2vw,21px)*var(--bs))]`}
        >
          {t('intro')}
        </p>
        <div className="mt-[22px] flex flex-wrap items-center gap-2.5">
          <Link
            to="/join"
            onClick={opens({ mode: 'join' })}
            className={PILL}
            data-testid="front-join"
          >
            {t('join')}
          </Link>
          <Link
            to="/login"
            onClick={opens({ mode: 'login' })}
            className={PILL_QUIET}
            data-testid="front-login"
          >
            {t('logIn')}
          </Link>
        </div>

        <section className="mt-[clamp(40px,6.4vw,76px)] border-t border-ink pt-3.5">
          <div
            className="flex flex-wrap items-center justify-between gap-x-7 gap-y-2.5"
            data-testid="front-strip"
          >
            {span ? (
              <h2 className={`${HEAD} leading-[1.3] [font-size:calc(26px*var(--hs))]`}>{span}</h2>
            ) : !data && loading ? (
              <span className="inline-block h-6 w-72 max-w-full animate-pulse rounded bg-hover" />
            ) : null}
            <nav
              aria-label={t('titlesIn')}
              className="ml-auto flex shrink-0 items-center gap-2.5 text-[13px] text-muted"
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
                    className={`rounded-full px-3 py-1 font-medium hover:no-underline ${
                      titles === mode
                        ? 'bg-ink text-paper hover:text-paper'
                        : 'text-ink-2 hover:text-ink'
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
              <div className="mt-[26px] flex flex-col gap-3" aria-busy>
                <div className="h-10 w-3/4 animate-pulse rounded bg-hover" />
                <div className="h-10 w-1/2 animate-pulse rounded bg-hover" />
                <div className="h-4 w-1/3 animate-pulse rounded bg-hover" />
                <div className="mt-3 h-24 w-full max-w-[34em] animate-pulse rounded bg-hover" />
              </div>
            ) : null
          ) : posts.length === 0 ? (
            <p className={`mt-[26px] ${BODY} text-muted`}>{t('empty')}</p>
          ) : (
            <div data-testid="front-edition">
              <div className="mt-[26px] flex flex-wrap gap-x-[clamp(32px,5vw,72px)] gap-y-9">
                {lead ? post(lead, 'lead') : null}
                {side.length > 0 ? (
                  <div className="flex min-w-0 flex-[5_1_300px] flex-col">
                    {side.map((p, i) => (
                      <div key={p.article.id} className="flex flex-col">
                        {i > 0 ? <div className={`${RULE} my-[22px]`} /> : null}
                        {post(p, 'side')}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              {under.length > 0 ? (
                <>
                  <div className={`${RULE} mt-9 mb-7`} />
                  <div className="columns-[3_15rem] gap-x-[clamp(32px,4vw,48px)] [column-rule:1px_solid_var(--color-line)]">
                    {under.map((p) => post(p, 'rest'))}
                  </div>
                </>
              ) : null}
            </div>
          )}
        </section>

        <section
          className="mt-10 flex flex-wrap gap-x-[clamp(32px,5vw,72px)] gap-y-2.5 border-t border-line pt-6"
          data-testid="writers-strip"
        >
          <h2 className={`${HEAD} flex-[0_1_240px] leading-[1.3] [font-size:calc(24px*var(--hs))]`}>
            {t('writers.title')}
          </h2>
          <div className="flex max-w-[36em] min-w-0 flex-[1_1_360px] flex-col items-start gap-3">
            <p className={`${STANDFIRST} text-ink-2 [font-size:calc(18px*var(--bs))]`}>
              {t('writers.intro')}
            </p>
            <Link to="/writers" className={`${TEXT_LINK} text-[15px]`}>
              {t('writers.cta')}
              <span aria-hidden="true"> →</span>
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter year={new Date(now).getFullYear()} />
    </>
  )
}

/**
 * A title's size by its place: the lead's large, then smaller down the page. A feed that gives its
 * posts no titles has its first paragraph for one, so a title stops at four lines, and the other
 * title under it at two.
 */
const TITLE_SIZE: Record<Place, string> = {
  lead: 'm-0 line-clamp-4 font-serif leading-(--lh-t) text-balance text-ink [overflow-wrap:break-word] [font-weight:var(--hw)] [letter-spacing:var(--track)] [font-size:calc(clamp(30px,4.2vw,44px)*var(--ts))]',
  side: `${POST_TITLE} line-clamp-4 [font-size:calc(24px*var(--ts))]`,
  rest: `${POST_TITLE} line-clamp-4 [font-size:calc(21px*var(--ts))]`,
}

/** The other title, under the first, in its own language. */
const OTHER_SIZE: Record<Place, string> = {
  lead: 'line-clamp-3 [font-size:calc(19px*var(--ts))]',
  side: 'line-clamp-2 [font-size:calc(16px*var(--ts))]',
  rest: 'line-clamp-2 [font-size:calc(15.5px*var(--ts))]',
}

/**
 * A post as type: its title (the link to it), the title in the other language beneath, and a
 * byline of the blog, who wrote it and when; the lead adds its excerpt. No card, swatch, language
 * label or reading time (Tela Public).
 */
function Post({
  post,
  place,
  titles,
  reading,
  locale,
  now,
  member,
}: {
  post: FrontPost
  place: Place
  titles: TitlesMode
  reading: string
  locale: string
  now: number
  member: MemberControls | undefined
}) {
  const { article, site, claimant } = post
  const shown = editionTitles(article, titles, reading, locale)
  const source = site.title ?? blogAddress(site.homeUrl)
  // Who wrote it, beside the blog: the member who claimed it, linked to their card, or the feed's
  // own byline. The columns under the lead name only the blog.
  const author = place === 'rest' ? null : bylineName(article.author, source)
  const byline =
    place === 'rest' ? null : claimant ? (
      <Link to={`/@${claimant.handle}`} className={QUIET_LINK}>
        {claimant.displayName ?? `@${claimant.handle}`}
      </Link>
    ) : (
      author
    )
  return (
    <article
      className={`flex min-w-0 flex-col ${
        place === 'lead'
          ? 'flex-[7_1_420px] gap-2.5'
          : place === 'side'
            ? 'gap-[7px]'
            : 'break-inside-avoid gap-1.5 pb-[26px]'
      }`}
      data-testid={place === 'lead' ? 'front-lead' : 'front-post'}
    >
      <h3 lang={shown.big.lang} className={TITLE_SIZE[place]} data-testid="front-title">
        <PostLink
          article={article}
          source={source}
          member={member}
          vouched={site.vouched}
          className={LINK}
        >
          {shown.big.text}
        </PostLink>
      </h3>
      {shown.small ? (
        <p
          lang={shown.small.lang}
          className={`m-0 font-serif leading-(--lh-h) text-muted ${OTHER_SIZE[place]}`}
          data-testid="front-other-title"
        >
          {shown.small.text}
        </p>
      ) : null}
      <div
        className={`${place === 'lead' ? 'text-[13.5px]' : 'text-[13px]'} leading-normal text-muted [overflow-wrap:anywhere]`}
      >
        <Link to={`/s/${site.id}`} className={`${QUIET_LINK} font-medium`}>
          {source}
        </Link>
        {/* The dot stays with what follows it; a name may be long enough to need to break. */}
        {byline ? (
          <>
            {' '}
            <span>·&nbsp;{byline}</span>
          </>
        ) : null}{' '}
        <span className="whitespace-nowrap">
          ·&nbsp;{relativeTime(article.sortAt, locale, now)}
        </span>
      </div>
      {place === 'lead' && shown.excerpt ? (
        <p
          lang={shown.excerpt.lang}
          className="m-0 mt-1.5 line-clamp-4 max-w-[34em] font-serif leading-(--lh-p) text-pretty text-body [font-size:calc(20px*var(--ts))]"
        >
          {shown.excerpt.text}
        </p>
      ) : null}
    </article>
  )
}
