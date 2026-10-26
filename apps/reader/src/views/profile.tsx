/**
 * A member's public profile (`/@handle`, Tela v2): who they are, how many they follow and are
 * followed by, and what they recommend, like, read and share as blogrolls (ADR 0050), as far as
 * they show it. Pure: the SPA and the edge both render it, and a member's own state (Follow, their
 * counts, their own blogrolls) comes in by props.
 */

import { recommendationKey } from '@tela/shared'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { BLOGROLL_GRID, BlogrollCard } from '../components/blogroll-card'
import { PersonAvatar } from '../components/person-avatar'
import { ReportLink } from '../components/report-link'
import { SiteAvatar } from '../components/site-avatar'
import { displayHost, monthYear, shortDate, swatchColor } from '../lib/format'
import { publicTitle } from '../lib/public-title'
import { PostLink } from './post-link'
import type {
  BlogrollCard as BlogrollCardData,
  MemberControls,
  ProfileData,
  PublicArticle,
  Reading,
} from './types'

export const PROFILE_TABS = ['recommendations', 'blogrolls', 'liked', 'subscriptions'] as const
export type ProfileTab = (typeof PROFILE_TABS)[number]

/**
 * The member's own blogrolls on their own profile, from their device (ADR 0050): every one,
 * private ones too, newest first. Given, the Blogrolls tab always shows, with New blogroll.
 */
export type OwnBlogrolls = {
  cards: readonly { card: BlogrollCardData; isPublic: boolean }[]
  /** New blogroll: the page opens its dialog, which gives focus back to the button pressed. */
  onNew: (opener: HTMLElement) => void
}

/**
 * The tab a URL asks for, as far as the profile shows it; recommendations otherwise. Blogrolls
 * show to others once the member has a public one, and always on their own profile (`own`).
 */
export function profileTab(asked: string | null, data: ProfileData, own = false): ProfileTab {
  if (asked === 'blogrolls' && (own || data.blogrolls.length > 0)) return 'blogrolls'
  if (asked === 'liked' && data.liked) return 'liked'
  if (asked === 'subscriptions' && data.subscriptions) return 'subscriptions'
  return 'recommendations'
}

export function ProfileView({
  data,
  tab,
  member,
  reading,
  locale,
  now,
  counts = data.counts,
  own,
}: {
  data: ProfileData
  tab: ProfileTab
  member?: MemberControls | undefined
  reading: Reading
  locale: string
  now: number
  /** The counts to show: the page's, or the member's own device's where it knows better. */
  counts?: ProfileData['counts'] | undefined
  /** The member's own profile: their blogrolls as their device holds them. */
  own?: OwnBlogrolls | undefined
}) {
  const t = useTranslations('profile')
  const { profile } = data
  const name = profile.displayName ?? `@${profile.handle}`
  const here = `/@${profile.handle}`
  // No id is an answer from a tela-api before follows: nothing to follow, and nothing to edit here.
  const known = profile.id !== ''
  const mine = known && member !== undefined && member.userId === profile.id
  const following = known && member?.isFollowing(profile.id) === true
  const person = { id: profile.id, handle: profile.handle, displayName: profile.displayName }
  const tabs = PROFILE_TABS.filter((k) =>
    k === 'recommendations'
      ? true
      : k === 'blogrolls'
        ? own !== undefined || data.blogrolls.length > 0
        : k === 'liked'
          ? data.liked
          : data.subscriptions,
  )
  // The page counts the blogrolls it lists; the owner's device counts their private ones too.
  const countOf = (k: ProfileTab) =>
    k === 'blogrolls'
      ? (own?.cards.length ?? data.blogrolls.length)
      : !counts
        ? null
        : k === 'recommendations'
          ? counts.recommendations
          : k === 'liked'
            ? counts.liked
            : counts.subscriptions
  const pill =
    'col-start-3 row-start-1 shrink-0 rounded-full border px-4 py-2 font-medium hover:no-underline whitespace-nowrap max-md:flex max-md:min-h-10 max-md:items-center max-md:py-0 max-md:text-[13.5px]'

  return (
    <main
      className="mx-auto w-full max-w-[960px] flex-1 animate-fade px-5 pt-7 pb-24 md:px-12 md:pt-14"
      data-testid="profile-page"
    >
      {/*
        A grid, in the order it reads: avatar, name, the pill, then the rest. On a phone the avatar
        and the pill share the first row and the rest runs full width below (Tela Mobile 11); from
        md the avatar spans the rows beside the name, and the rest spans the name's column and the
        pill's, so its measure is the one a single column had. CSS alone: the edge renders this.
      */}
      <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 md:grid-rows-[auto_1fr] md:gap-x-4 md:gap-y-2.5">
        <PersonAvatar
          handle={profile.handle}
          displayName={profile.displayName}
          avatar={profile.avatar}
          size={112}
          me={mine}
          className="col-start-1 row-start-1 max-md:!size-18 max-md:!text-[30px] md:row-end-3 md:mr-4"
        />
        <div className="col-span-full row-start-2 mt-4 min-w-0 md:col-[2] md:row-start-1 md:mt-0">
          <h1 className="m-0 font-serif text-[34px] leading-[1.05] font-medium tracking-[-0.02em] [overflow-wrap:anywhere] md:text-[46px]">
            {name}
          </h1>
          <div className="mt-1 text-[13px] text-muted md:mt-2 md:text-[13.5px]">
            @{profile.handle} · {t('joined', { when: monthYear(profile.memberSince, locale) })}
            {known && !mine ? (
              <>
                {' · '}
                <ReportLink
                  subject={{ kind: 'profile', key: profile.id }}
                  path={here}
                  member={member !== undefined}
                />
              </>
            ) : null}
          </div>
        </div>
        {mine ? (
          <Link
            to="/settings/profile"
            className={`${pill} border-thumb text-ink hover:border-ink`}
            data-testid="edit-profile"
          >
            {t('editProfile')}
          </Link>
        ) : member && known ? (
          <button
            type="button"
            aria-pressed={following}
            onClick={() => member.setFollowing(person, !following)}
            className={`${pill} ${following ? 'border-thumb text-ink-2' : 'border-ink bg-ink text-paper'}`}
            data-testid="follow-button"
          >
            {following ? t('following') : t('follow')}
          </button>
        ) : member ? null : (
          <Link
            to={`/login?next=${encodeURIComponent(here)}`}
            className={`${pill} border-ink bg-ink text-paper`}
          >
            {t('follow')}
          </Link>
        )}
        {profile.bio || counts || data.blogs.length > 0 ? (
          <div className="col-span-full row-start-3 flex min-w-0 flex-col md:col-[2/4] md:row-start-2 md:gap-2.5">
            {profile.bio ? (
              <p
                className="mt-3 mb-0 max-w-[560px] font-serif text-[18px] leading-[1.45] text-body md:mt-1.5 md:text-[20px]"
                style={{ textWrap: 'pretty' }}
              >
                {profile.bio}
              </p>
            ) : null}
            {counts ? (
              <div
                className="mt-2.5 flex flex-wrap gap-x-[18px] gap-y-1 text-[13.5px] text-ink-2 md:mt-1.5 md:gap-x-[22px]"
                data-testid="profile-counts"
              >
                {(['following', 'followers', 'recommendations'] as const).map((k) => (
                  <span key={k} data-testid={`profile-count-${k}`}>
                    {t.rich(`stats.${k}`, {
                      n: counts[k],
                      b: (chunks) => <b className="font-semibold text-ink">{chunks}</b>,
                    })}
                  </span>
                ))}
              </div>
            ) : null}
            {data.blogs.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-ink-2 md:mt-0">
                <span>{t('writes')}</span>
                {data.blogs.map((site) => (
                  <Link
                    key={site.id}
                    to={`/s/${site.id}`}
                    className="flex items-center gap-1.5 font-medium text-ink hover:underline"
                  >
                    <SiteAvatar
                      id={site.id}
                      title={site.title ?? site.homeUrl}
                      faviconKey={site.faviconKey}
                      size={18}
                    />
                    {site.title ?? displayHost(site.homeUrl)}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      {/* On a phone the rule runs edge to edge, as Following's does. */}
      <nav
        className="-mx-5 mt-6 flex gap-5 overflow-x-auto overflow-y-hidden border-b border-line px-5 [scrollbar-width:none] md:mx-0 md:mt-12 md:gap-7 md:px-0"
        aria-label={name}
      >
        {tabs.map((k) => (
          <Link
            key={k}
            to={k === 'recommendations' ? here : `${here}?tab=${k}`}
            replace
            aria-current={k === tab ? 'page' : undefined}
            className={`-mb-px flex shrink-0 gap-1.5 border-b-2 py-2.5 font-medium hover:text-ink hover:no-underline ${
              k === tab ? 'border-ink text-ink' : 'border-transparent text-muted'
            }`}
            data-testid={`profile-tab-${k}`}
          >
            {t(`tabs.${k}`)}
            <span className="font-normal text-muted">{countOf(k)}</span>
          </Link>
        ))}
      </nav>

      {tab === 'blogrolls' ? (
        <Blogrolls
          cards={own ? own.cards : data.blogrolls.map((card) => ({ card, isPublic: true }))}
          onNew={own?.onNew}
        />
      ) : tab === 'subscriptions' && data.subscriptions ? (
        <Subscriptions subscriptions={data.subscriptions} />
      ) : (
        <Posts
          testId={tab === 'liked' ? 'profile-liked' : 'profile-recommendations'}
          items={
            tab === 'liked'
              ? (data.liked ?? []).map((l) => ({ ...l, at: l.likedAt, note: null }))
              : data.recommendations.map((r) => ({ ...r, at: r.createdAt }))
          }
          // Someone else's notes can be reported (ADR 0059); a liked post carries none.
          reportAs={known && !mine && tab !== 'liked' ? { userId: profile.id, path: here } : null}
          member={member}
          reading={reading}
          locale={locale}
          now={now}
        />
      )}
    </main>
  )
}

type PostItem = {
  at: number
  note: string | null
  siteId: number
  siteTitle: string | null
  homeUrl: string
  /** An operator listed the blog: the post's link is followed (ADR 0060). */
  vouched?: boolean
  article: PublicArticle
}

/** A column of posts: when on the left, the note (if any) and the post on the right. */
function Posts({
  items,
  member,
  reading,
  locale,
  now,
  testId,
  reportAs = null,
}: {
  items: PostItem[]
  /** Whose notes these are, and the page they are on, when a reader may report one. */
  reportAs?: { userId: string; path: string } | null
  member: MemberControls | undefined
  reading: Reading
  locale: string
  now: number
  testId: string
}) {
  const t = useTranslations('profile')
  const tc = useTranslations('common')
  if (items.length === 0) {
    return (
      <p className="py-12 text-center text-muted" data-testid={testId}>
        {t('nothing')}
      </p>
    )
  }
  return (
    <div data-testid={testId}>
      {items.map((item) => {
        const source = item.siteTitle ?? displayHost(item.homeUrl)
        const { title, badge } = publicTitle(item.article, reading)
        return (
          <article
            key={item.article.id}
            className="grid animate-fade grid-cols-[52px_minmax(0,1fr)] gap-3 border-b border-line py-5 md:grid-cols-[96px_minmax(0,1fr)] md:gap-6 md:py-7"
          >
            <div className="pt-[3px] text-[12.5px] text-muted">
              {shortDate(item.at, locale, now)}
            </div>
            <div className="flex min-w-0 flex-col gap-2 md:gap-3">
              {item.note ? (
                <div className="flex flex-col items-start gap-1">
                  <p
                    className="m-0 font-serif text-[19px] leading-[1.4] italic md:text-[21px]"
                    style={{ textWrap: 'pretty' }}
                  >
                    {tc('quoted', { text: item.note })}
                  </p>
                  {reportAs ? (
                    <ReportLink
                      subject={{
                        kind: 'recommendation',
                        key: recommendationKey(reportAs.userId, item.article.id),
                      }}
                      path={reportAs.path}
                      member={member !== undefined}
                    />
                  ) : null}
                </div>
              ) : null}
              <div className="relative flex flex-col gap-1.5 hover:opacity-75">
                <div className="flex items-center gap-2 text-[12.5px] text-muted">
                  <span
                    aria-hidden="true"
                    className="size-2.5 rounded-[3px]"
                    style={{ background: swatchColor(item.article.feedId) }}
                  />
                  <span className="font-medium text-ink">{source}</span>
                  {badge ? (
                    <span className="rounded border border-line px-[5px] text-[10.5px]">
                      {badge}
                    </span>
                  ) : null}
                </div>
                {/* Under the page's h1 with no section heading between: an h3 skipped a level. */}
                <h2 className="m-0 font-serif text-[21px] leading-[1.2] font-medium tracking-[-0.005em] md:text-[24px]">
                  <PostLink
                    article={item.article}
                    source={source}
                    member={member}
                    vouched={item.vouched}
                    className="text-ink after:absolute after:inset-0 hover:no-underline"
                  >
                    {title}
                  </PostLink>
                </h2>
              </div>
            </div>
          </article>
        )
      })}
    </div>
  )
}

/**
 * The Blogrolls tab. Others see the public ones; the owner sees every one, with a line on what a
 * blogroll is for and New blogroll, or an empty state that offers it.
 */
function Blogrolls({
  cards,
  onNew,
}: {
  cards: OwnBlogrolls['cards']
  onNew: OwnBlogrolls['onNew'] | undefined
}) {
  const t = useTranslations('profile.blogrolls')
  const create = onNew ? (
    <button
      type="button"
      onClick={(e) => onNew(e.currentTarget)}
      className="shrink-0 rounded-full border border-thumb px-3.5 py-[7px] text-[13px] font-medium whitespace-nowrap text-ink hover:border-ink max-md:min-h-10"
      data-testid="new-blogroll"
    >
      {t('new')}
    </button>
  ) : null
  if (cards.length === 0) {
    // Only the owner's: others see the tab once there is a blogroll in it.
    return (
      <div
        className="flex flex-col items-center gap-4 py-12 text-center"
        data-testid="profile-blogrolls"
      >
        <p className="m-0 max-w-[420px] text-muted">{t('empty')}</p>
        {create}
      </div>
    )
  }
  return (
    <section className="mt-7" data-testid="profile-blogrolls">
      {create ? (
        <div className="mb-[18px] flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="m-0 text-[13.5px] text-muted">{t('intro')}</p>
          {create}
        </div>
      ) : null}
      <ul className={BLOGROLL_GRID.profile}>
        {cards.map(({ card, isPublic }) => (
          <li key={card.id} className="flex min-w-0">
            <BlogrollCard card={card} variant="profile" isPrivate={!isPublic} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function Subscriptions({
  subscriptions,
}: {
  subscriptions: NonNullable<ProfileData['subscriptions']>
}) {
  const t = useTranslations('profile')
  if (subscriptions.length === 0) {
    return (
      <p className="py-12 text-center text-muted" data-testid="profile-subscriptions">
        {t('nothing')}
      </p>
    )
  }
  return (
    <ul
      className="m-0 mt-7 grid list-none grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5 p-0"
      data-testid="profile-subscriptions"
    >
      {subscriptions.map((s) => {
        const title = s.title ?? displayHost(s.homeUrl)
        return (
          <li
            key={s.id}
            className="relative flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-[18px] hover:border-muted"
          >
            <div className="flex items-center gap-3">
              <SiteAvatar id={s.id} title={title} faviconKey={s.faviconKey} size={36} />
              <div className="min-w-0">
                {/* A private blog has no public page to link to. */}
                {s.listed ? (
                  <Link
                    to={`/s/${s.id}`}
                    className="font-medium text-ink after:absolute after:inset-0 hover:no-underline"
                  >
                    {title}
                  </Link>
                ) : (
                  <span className="font-medium">{title}</span>
                )}
                <div className="truncate text-[12.5px] text-muted">{displayHost(s.homeUrl)}</div>
              </div>
            </div>
            {s.description ? (
              <p className="m-0 line-clamp-3 font-serif text-[16.5px] leading-[1.35] text-body">
                {s.description}
              </p>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
