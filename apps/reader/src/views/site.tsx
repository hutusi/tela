/**
 * A blog's public page (`/s/:siteId`, Tela v2): what it is and who writes it, its posts, and what
 * readers said of them. Pure: the SPA and the edge both render it. The readers a member follows
 * come in by props, from a member call beside this cached page, never in it.
 */
import { LANGUAGE_NAMES, type UiLocale } from '@tela/shared'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { PersonAvatar } from '../components/person-avatar'
import { SiteAvatar } from '../components/site-avatar'
import { cadenceKey, displayHost, shortDate } from '../lib/format'
import { publicTitle } from '../lib/public-title'
import { PostLink } from './post-link'
import type { MemberControls, Person, Reading, SiteData } from './types'

const LABEL = 'm-0 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase'

export function SiteView({
  data,
  member,
  reading,
  locale,
  now,
  ownerPanel,
  readers = [],
}: {
  data: SiteData
  member?: MemberControls | undefined
  reading: Reading
  locale: string
  now: number
  /** The blog's settings, shown to the member who claimed it. */
  ownerPanel?: React.ReactNode
  /** The people the member follows who read this blog, as far as they show it. */
  readers?: Person[]
}) {
  const t = useTranslations('site')
  const td = useTranslations('discover')
  const { site } = data
  const title = site.title ?? displayHost(site.homeUrl)
  const primary = data.feeds[0]
  const subscribed = primary !== undefined && member?.isSubscribed(primary.id) === true
  const here = `/s/${site.id}`
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  const claimant = site.claimant
  const author = claimant ? (claimant.displayName ?? `@${claimant.handle}`) : null
  const pill = 'rounded-full border px-4 py-[7px] text-[13px] font-medium hover:no-underline'

  return (
    <main
      className="mx-auto w-full max-w-[1080px] flex-1 animate-fade px-4 pt-10 pb-24 md:px-12 md:pt-14"
      data-testid="site-page"
    >
      <header className="flex flex-wrap items-start gap-6 border-b border-line pb-10 md:gap-7">
        <SiteAvatar id={site.id} title={title} faviconKey={site.faviconKey} size={84} radius={20} />
        <div className="flex min-w-[260px] flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2 text-[13px] text-muted">
            <span>{displayHost(site.homeUrl)}</span>
            {claimant ? (
              <>
                <span>·</span>
                <Link
                  to={`/@${claimant.handle}`}
                  className="text-accent"
                  data-testid="claimed-badge"
                  title={td('claimed')}
                >
                  {t('claimedByName', { name: author ?? '' })}
                </Link>
              </>
            ) : null}
          </div>
          <h1 className="m-0 font-serif text-[40px] leading-none font-medium tracking-[-0.02em] md:text-[56px]">
            {title}
          </h1>
          {site.description ? (
            <p className="mt-1 mb-0 font-serif text-[23px] text-ink-2 italic">{site.description}</p>
          ) : null}
          <div className="mt-2.5 flex flex-wrap gap-x-[18px] gap-y-1 text-[13.5px] text-ink-2">
            {site.primaryLang ? (
              <span>{t('writtenIn', { lang: names[site.primaryLang] ?? site.primaryLang })}</span>
            ) : null}
            <span>{t('cadence', { key: cadenceKey(site.postsLast30d) })}</span>
            <span>{t('readersOnTela', { n: site.readerCount })}</span>
          </div>
          {data.topics.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data.topics.map((topic) => (
                <Link
                  key={topic}
                  to={`/discover?topic=${topic}`}
                  className="rounded-full border border-line px-2.5 py-0.5 text-[12px] text-ink-2 hover:border-ink hover:no-underline"
                >
                  {td(`topics.${topic}`)}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <a
              href={site.homeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${pill} border-thumb text-ink hover:border-ink`}
            >
              {t('visit')}
            </a>
            {primary ? (
              member ? (
                <button
                  type="button"
                  onClick={() => member.toggle(primary.id, subscribed)}
                  data-testid="site-subscribe"
                  aria-pressed={subscribed}
                  className={`${pill} ${subscribed ? 'border-thumb text-ink-2' : 'border-ink bg-ink text-paper'}`}
                >
                  {subscribed ? td('subscribed') : td('subscribe')}
                </button>
              ) : (
                <Link
                  to={`/login?next=${encodeURIComponent(here)}`}
                  className={`${pill} border-ink bg-ink text-paper`}
                >
                  {td('subscribe')}
                </Link>
              )
            ) : null}
          </div>
          {!claimant && member ? (
            <Link
              to={`/sites/${site.id}/claim`}
              className="text-[13px] text-muted hover:text-ink"
              data-testid="claim-link"
            >
              {t('claimLink')}
            </Link>
          ) : null}
        </div>
      </header>

      {ownerPanel ? <div className="mt-6">{ownerPanel}</div> : null}

      <div className="mt-9 grid grid-cols-1 items-start gap-12 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-16">
        <section className="min-w-0">
          <h2 className={`${LABEL} mb-1.5`}>{t('posts')}</h2>
          {data.posts.length === 0 ? (
            <p className="text-muted">{t('noPosts')}</p>
          ) : (
            <ul className="m-0 list-none p-0" data-testid="site-articles">
              {data.posts.map((a) => {
                const shown = publicTitle(a, reading)
                return (
                  <li
                    key={a.id}
                    className="relative grid grid-cols-[72px_minmax(0,1fr)] gap-4 border-b border-line py-[22px] hover:opacity-75 md:grid-cols-[96px_minmax(0,1fr)] md:gap-6"
                  >
                    <div className="pt-[5px] text-[12.5px] text-muted">
                      {shortDate(a.publishedAt ?? a.fetchedAt, locale, now)}
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <h3
                        className="m-0 font-serif text-[24px] leading-[1.2] font-medium"
                        style={{ textWrap: 'pretty' }}
                      >
                        <PostLink
                          article={a}
                          source={title}
                          member={member}
                          className="text-ink after:absolute after:inset-0 hover:no-underline"
                        >
                          {shown.title}
                        </PostLink>
                      </h3>
                      {a.excerpt ? (
                        <p className="m-0 line-clamp-2 font-serif text-[17px] leading-[1.45] text-ink-2">
                          {a.excerpt}
                        </p>
                      ) : null}
                      <div className="flex gap-3 text-[12px] text-muted">
                        <span>{t('minutes', { n: a.readingMinutes || 1 })}</span>
                        <span>♡ {a.likeCount}</span>
                        {shown.badge ? <span>{shown.badge}</span> : null}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <aside className="flex flex-col gap-9 lg:sticky lg:top-24">
          {claimant && (claimant.bio || claimant.displayName) ? (
            <section data-testid="site-about">
              <h2 className={`${LABEL} mb-2.5`}>{t('about')}</h2>
              <Link
                to={`/@${claimant.handle}`}
                className="mb-2 flex items-center gap-2.5 font-medium text-ink hover:no-underline"
              >
                <PersonAvatar
                  handle={claimant.handle}
                  displayName={claimant.displayName}
                  size={28}
                  me={member?.handle === claimant.handle}
                />
                {author}
              </Link>
              {claimant.bio ? (
                <p className="m-0 font-serif text-[17.5px] leading-normal text-body">
                  {claimant.bio}
                </p>
              ) : null}
            </section>
          ) : null}
          {readers.length > 0 ? (
            <section data-testid="site-readers">
              <h2 className={`${LABEL} mb-3`}>{t('readersYouFollow')}</h2>
              <div className="mb-2.5 flex pl-1.5">
                {readers.map((p) => (
                  <Link
                    key={p.id}
                    to={`/@${p.handle}`}
                    title={p.displayName ?? p.handle}
                    className="-ml-1.5 rounded-full border-2 border-paper hover:no-underline"
                  >
                    <PersonAvatar handle={p.handle} displayName={p.displayName} size={32} />
                  </Link>
                ))}
              </div>
              <p className="m-0 text-[13px] leading-[1.45] text-ink-2">
                <ReadersText readers={readers} />
              </p>
            </section>
          ) : null}
          {data.notes.length > 0 ? (
            <section data-testid="site-notes">
              <h2 className={`${LABEL} mb-1`}>{t('fromReaders')}</h2>
              {data.notes.map((n) => (
                <div
                  key={`${n.person.handle}:${n.article.id}`}
                  className="border-b border-line py-3.5"
                >
                  <p className="m-0 font-serif text-[18px] leading-[1.4] italic">“{n.note}”</p>
                  <div className="mt-2 text-[12.5px] leading-[1.4] text-muted">
                    {t.rich('noteOn', {
                      person: () => (
                        <Link
                          to={`/@${n.person.handle}`}
                          className="font-medium text-ink hover:underline"
                        >
                          {n.person.displayName ?? `@${n.person.handle}`}
                        </Link>
                      ),
                      post: () => (
                        <PostLink
                          article={n.article}
                          source={title}
                          member={member}
                          className="text-ink-2 hover:underline"
                        >
                          {publicTitle(n.article, reading).title}
                        </PostLink>
                      ),
                    })}
                  </div>
                </div>
              ))}
            </section>
          ) : null}
        </aside>
      </div>
    </main>
  )
}

/** "Anna reads this blog.", "Anna and Jonas read …", "Anna, Jonas and 2 others read …". */
function ReadersText({ readers }: { readers: Person[] }) {
  const t = useTranslations('site')
  const first = (p: Person | undefined) =>
    p ? ((p.displayName ?? p.handle).split(' ')[0] ?? p.handle) : ''
  const [a, b] = readers
  if (readers.length === 1) return <>{t('readersText.one', { a: first(a) })}</>
  if (readers.length === 2) return <>{t('readersText.two', { a: first(a), b: first(b) })}</>
  return (
    <>
      {t('readersText.more', {
        a: first(a),
        b: first(b),
        n: readers.length - 2,
        total: readers.length,
      })}
    </>
  )
}
