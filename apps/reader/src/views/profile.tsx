/** A member's public profile (`/@handle`): the blogs they write, what they recommend and read. */
import { languageBadge } from '@tela/shared'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { SiteAvatar } from '../components/site-avatar'
import { displayHost, relativeTime } from '../lib/format'
import { PostLink } from './post-link'
import type { MemberControls, ProfileData } from './types'

export function ProfileView({
  data,
  member,
  locale,
  now,
}: {
  data: ProfileData
  member?: MemberControls | undefined
  locale: string
  now: number
}) {
  const t = useTranslations('profile')
  const { profile } = data
  const name = profile.displayName ?? `@${profile.handle}`

  return (
    <main
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-12 animate-fade md:px-8"
      data-testid="profile-page"
    >
      <header className="flex items-start gap-5">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-accent font-serif text-2xl font-semibold text-white">
          {name.replace(/^@/, '').charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
            {name}
          </h1>
          <div className="mt-1 text-[13px] text-muted">
            @{profile.handle} ·{' '}
            {t('memberSince', { when: relativeTime(profile.memberSince, locale, now) })}
          </div>
          {profile.bio ? (
            <p className="mt-3 max-w-xl font-serif text-[18px] leading-[1.4] text-body">
              {profile.bio}
            </p>
          ) : null}
        </div>
      </header>

      {data.blogs.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-serif text-[22px] font-medium">{t('writes')}</h2>
          <ul className="m-0 flex list-none flex-wrap gap-3 p-0">
            {data.blogs.map((site) => (
              <li key={site.id}>
                <Link
                  to={`/s/${site.id}`}
                  className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-ink hover:border-ink hover:no-underline"
                >
                  <SiteAvatar
                    id={site.id}
                    title={site.title ?? site.homeUrl}
                    faviconKey={site.faviconKey}
                    size={28}
                  />
                  <span className="font-medium">{site.title ?? displayHost(site.homeUrl)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3" data-testid="profile-recommendations">
        <h2 className="font-serif text-[22px] font-medium">{t('recommendations')}</h2>
        {data.recommendations.length === 0 ? (
          <p className="text-muted">{t('noRecommendations')}</p>
        ) : null}
        {data.recommendations.map((r) => {
          const source = r.siteTitle ?? displayHost(r.homeUrl)
          return (
            <article key={r.article.id} className="rounded-xl border border-line bg-surface p-4">
              <PostLink
                article={r.article}
                source={source}
                member={member}
                className="font-serif text-[19px] font-medium leading-tight text-ink hover:underline"
              />
              <div className="mt-1 text-[12.5px] text-muted">
                <Link to={`/s/${r.siteId}`}>{source}</Link>
                {r.article.sourceLang ? ` · ${languageBadge(r.article.sourceLang)}` : ''}
                {` · ${relativeTime(r.createdAt, locale, now)}`}
              </div>
              {r.note ? (
                <p className="mt-2 font-serif text-[17px] leading-[1.45] text-body">“{r.note}”</p>
              ) : null}
            </article>
          )
        })}
      </section>

      {data.subscriptions ? (
        <section className="flex flex-col gap-3" data-testid="profile-subscriptions">
          <h2 className="font-serif text-[22px] font-medium">{t('reads')}</h2>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {data.subscriptions.map((s) => {
              const title = s.title ?? displayHost(s.homeUrl)
              const chip = (
                <>
                  <SiteAvatar id={s.id} title={title} faviconKey={s.faviconKey} size={22} />
                  {title}
                </>
              )
              const cls =
                'flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1 pr-3 text-[13px] text-ink'
              return (
                <li key={s.id}>
                  {/* A private blog has no public page to link to. */}
                  {s.listed ? (
                    <Link
                      to={`/s/${s.id}`}
                      className={`${cls} hover:border-ink hover:no-underline`}
                    >
                      {chip}
                    </Link>
                  ) : (
                    <span className={cls}>{chip}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </main>
  )
}
