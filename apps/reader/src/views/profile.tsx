/**
 * A member's public profile (`/@handle`, Tela v2): who they are, how many they follow and are
 * followed by, and what they recommend, like and read, as far as they show it. Pure: the SPA and
 * the edge both render it, and a member's own state (Follow, their counts) comes in by props.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { PersonAvatar } from '../components/person-avatar'
import { SiteAvatar } from '../components/site-avatar'
import { displayHost, monthYear, shortDate, swatchColor } from '../lib/format'
import { publicTitle } from '../lib/public-title'
import { PostLink } from './post-link'
import type { MemberControls, ProfileData, PublicArticle, Reading } from './types'

export const PROFILE_TABS = ['recommendations', 'liked', 'subscriptions'] as const
export type ProfileTab = (typeof PROFILE_TABS)[number]

/** The tab a URL asks for, as far as the profile shows it; recommendations otherwise. */
export function profileTab(asked: string | null, data: ProfileData): ProfileTab {
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
}: {
  data: ProfileData
  tab: ProfileTab
  member?: MemberControls | undefined
  reading: Reading
  locale: string
  now: number
  /** The counts to show: the page's, or the member's own device's where it knows better. */
  counts?: ProfileData['counts'] | undefined
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
    k === 'recommendations' ? true : k === 'liked' ? data.liked : data.subscriptions,
  )
  const countOf = (k: ProfileTab) =>
    !counts
      ? null
      : k === 'recommendations'
        ? counts.recommendations
        : k === 'liked'
          ? counts.liked
          : counts.subscriptions
  const pill =
    'shrink-0 rounded-full border px-4 py-2 font-medium hover:no-underline whitespace-nowrap'

  return (
    <main
      className="mx-auto w-full max-w-[960px] flex-1 animate-fade px-4 pt-10 pb-24 md:px-12 md:pt-14"
      data-testid="profile-page"
    >
      <header className="flex flex-wrap items-start gap-6 md:gap-8">
        <PersonAvatar
          handle={profile.handle}
          displayName={profile.displayName}
          avatar={profile.avatar}
          size={112}
          me={mine}
          className="max-md:!size-20 max-md:!text-[36px]"
        />
        <div className="flex min-w-[260px] flex-1 flex-col gap-2.5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="m-0 font-serif text-[36px] leading-[1.05] font-medium tracking-[-0.02em] md:text-[46px]">
                {name}
              </h1>
              <div className="mt-2 text-[13.5px] text-muted">
                @{profile.handle} · {t('joined', { when: monthYear(profile.memberSince, locale) })}
              </div>
            </div>
            {mine ? (
              <Link
                to="/settings"
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
          </div>
          {profile.bio ? (
            <p
              className="mt-1.5 mb-0 max-w-[560px] font-serif text-[20px] leading-[1.45] text-body"
              style={{ textWrap: 'pretty' }}
            >
              {profile.bio}
            </p>
          ) : null}
          {counts ? (
            <div
              className="mt-1.5 flex flex-wrap gap-x-[22px] gap-y-1 text-[13.5px] text-ink-2"
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
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-ink-2">
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
      </header>

      <nav
        className="mt-12 flex gap-7 overflow-x-auto border-b border-line [scrollbar-width:none]"
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

      {tab === 'subscriptions' && data.subscriptions ? (
        <Subscriptions subscriptions={data.subscriptions} />
      ) : (
        <Posts
          testId={tab === 'liked' ? 'profile-liked' : 'profile-recommendations'}
          items={
            tab === 'liked'
              ? (data.liked ?? []).map((l) => ({ ...l, at: l.likedAt, note: null }))
              : data.recommendations.map((r) => ({ ...r, at: r.createdAt }))
          }
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
}: {
  items: PostItem[]
  member: MemberControls | undefined
  reading: Reading
  locale: string
  now: number
  testId: string
}) {
  const t = useTranslations('profile')
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
            className="grid animate-fade grid-cols-[72px_minmax(0,1fr)] gap-4 border-b border-line py-7 md:grid-cols-[96px_minmax(0,1fr)] md:gap-6"
          >
            <div className="pt-[3px] text-[12.5px] text-muted">
              {shortDate(item.at, locale, now)}
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              {item.note ? (
                <p
                  className="m-0 font-serif text-[21px] leading-[1.4] italic"
                  style={{ textWrap: 'pretty' }}
                >
                  “{item.note}”
                </p>
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
                <h3 className="m-0 font-serif text-[24px] leading-[1.2] font-medium tracking-[-0.005em]">
                  <PostLink
                    article={item.article}
                    source={source}
                    member={member}
                    className="text-ink after:absolute after:inset-0 hover:no-underline"
                  >
                    {title}
                  </PostLink>
                </h3>
              </div>
            </div>
          </article>
        )
      })}
    </div>
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
