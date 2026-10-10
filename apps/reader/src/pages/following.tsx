/**
 * `/following` (Tela v2): what the people the member follows recommended, liked and subscribed to.
 * Their activity is other members' rows, so it comes by RPC, a page of entries at a time behind a
 * cursor (ADR 0031); whom the member follows is their own synced rows, so the aside needs no
 * network for them. What a page fetched is held for the visit, so Back renders at once, and the
 * first page is asked for again behind it. The readers it suggests are Discover's (ADR 0044): the
 * public pool, matched on the device by the same rule.
 */
import { languageBadge } from '@tela/shared'
import type { ArticleRow } from '@tela/sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { FollowButton } from '../components/follow-button'
import { PersonAvatar } from '../components/person-avatar'
import { ReasonDot, useReasonText } from '../components/reader-card'
import { SiteAvatar } from '../components/site-avatar'
import { READERS_PATH } from '../lib/discover-href'
import { appendPage, mergeFirstPage } from '../lib/following-feed'
import { displayHost, relativeTime, swatchColor } from '../lib/format'
import { useMemberControls } from '../lib/member'
import { suggestReaders } from '../lib/suggest-readers'
import { useTitle } from '../lib/title'
import { useMine, useReading } from '../lib/use-discover'
import { usePublic } from '../lib/use-public'
import { apiJson } from '../store/api'
import { useConfirmedFollowees, useNow, useStore, useTables } from '../store/hooks'
import { followedPeople } from '../store/selectors'
import { useUi } from '../ui'
import { PostLink } from '../views/post-link'
import type { MemberControls, Person, ReadersData, Reading } from '../views/types'

type Tab = 'all' | 'recs' | 'likes'
const TABS: Tab[] = ['all', 'recs', 'likes']

type Post = {
  siteId: number
  siteTitle: string | null
  homeUrl: string
  listed: boolean
  translatedTitle: string | null
  translatedExcerpt: string | null
  article: ArticleRow
}
type Site = {
  id: number
  title: string | null
  homeUrl: string
  description: string | null
  faviconKey: string | null
  primaryLang: string | null
  feedId: number | null
}
/** `key` is unique in the feed: what a cursor names, and what React keys the entry by. */
export type FeedItem =
  | {
      kind: 'recommended'
      key: string
      at: number
      person: Person
      note: string | null
      post: Post
    }
  | { kind: 'liked'; key: string; at: number; person: Person; count: number; posts: Post[] }
  | { kind: 'subscribed'; key: string; at: number; person: Person; count: number; sites: Site[] }
/** tela-api still sends `suggested`, always empty, for shells from before ADR 0044. */
type FeedPage = { items: FeedItem[]; next: string | null }

type Feed = {
  status: 'loading' | 'ready' | 'failed'
  /** Which tab in which language this is, so a refetch after a follow keeps it on screen. */
  view: string
  items: FeedItem[]
  next: string | null
}

/** What each tab fetched this visit, by member, tab, language and whom they followed. */
const held = new Map<string, Feed>()

const loading = (view: string): Feed => ({ status: 'loading', view, items: [], next: null })

function useFeed(tab: Tab, lang: string) {
  const { store } = useStore()
  // The feed is the server's answer about whom the member follows, so it is asked again once a
  // follow or an unfollow has reached the server and come back by the pull. Asked on the
  // prediction, the request beat the debounced push, and the answer, cached under the new
  // follows, never showed the person just followed.
  const followees = useConfirmedFollowees()
  // The device's offset is part of what a page means (it groups days), so a change starts afresh
  // rather than splicing pages grouped two ways.
  const tz = -new Date().getTimezoneOffset()
  const view = `${store.userId}:${tab}:${lang}:${tz}`
  const key = `${view}:${followees}`
  const [state, setFeed] = useState<Feed>(() => held.get(key) ?? loading(view))
  // Another tab or language shows its own from the render that names it, not after the effect:
  // the router commits a navigation in a transition, so that render paints. The same view after a
  // follow keeps its entries on screen until the fresh copy comes.
  const feed = state.view === view ? state : (held.get(key) ?? loading(view))
  const [busy, setBusy] = useState(false)
  // The key on screen now: an answer to a request made under another one updates what is held for
  // that one, never what this tab shows.
  const shown = useRef(key)
  shown.current = key

  const fetchPage = useCallback(
    async (cursor: string | null): Promise<FeedPage | null> => {
      const q = new URLSearchParams({ tab, lang, tz: String(tz) })
      if (cursor !== null) q.set('cursor', cursor)
      try {
        const { status, body } = await apiJson<FeedPage>(`/api/v1/following?${q}`)
        return status === 200 ? body : null
      } catch {
        return null
      }
    },
    [tab, lang, tz],
  )

  // What is held shows at once, and the first page is asked for again behind it: the people
  // followed may have done more since.
  useEffect(() => {
    let cancelled = false
    setBusy(false)
    const known = held.get(key)
    // The same tab after a follow stays on screen until its fresh copy comes; another tab loads.
    setFeed((now) => known ?? (now.view === view ? now : loading(view)))
    void fetchPage(null).then((page) => {
      if (cancelled) return
      const kept = held.get(key)
      if (!page) {
        if (!kept) setFeed({ ...loading(view), status: 'failed' })
        return
      }
      // The fresh first page over what is held, keeping the older pages loaded where they carry on.
      const merged = mergeFirstPage(kept?.status === 'ready' ? kept : null, page)
      const next: Feed = { status: 'ready', view, ...merged }
      held.set(key, next)
      setFeed(next)
    })
    return () => {
      cancelled = true
    }
  }, [key, view, fetchPage])

  const more = async () => {
    const asked = key
    const from = held.get(asked) ?? feed
    if (from.next === null || busy) return
    setBusy(true)
    const page = await fetchPage(from.next)
    if (shown.current === asked) setBusy(false)
    // Appended to what is held for the key it was asked under, if that still ends where this page
    // starts: a refresh in between replaced it, and the page would no longer follow on.
    const base = held.get(asked)
    if (!page || !base || base.next !== from.next) return
    const next: Feed = { ...base, ...appendPage(base, page) }
    held.set(asked, next)
    if (shown.current === asked) setFeed(next)
  }
  const retry = () => {
    const asked = key
    held.delete(asked)
    setFeed(loading(view))
    void fetchPage(null).then((page) => {
      const next: Feed = page
        ? { status: 'ready', view, items: page.items, next: page.next }
        : { ...loading(view), status: 'failed' }
      if (page) held.set(asked, next)
      if (shown.current === asked) setFeed(next)
    })
  }
  return { feed, more, busy, retry }
}

/** How many readers the aside suggests. */
const SUGGESTED = 5

/**
 * The readers to follow, by Discover's rule (ADR 0044): the public pool, matched against the
 * member's own likes, recommendations and blogs, without whom they followed as the page opened,
 * so a Follow from here keeps its row, showing Following.
 */
function useSuggested(reading: Reading) {
  const pool = usePublic<ReadersData>(READERS_PATH)
  const mine = useMine(reading)
  const data = pool.status === 'ready' ? pool.data : null
  return useMemo(
    () => (data && mine ? suggestReaders(data.readers, mine).slice(0, SUGGESTED) : []),
    [data, mine],
  )
}

export function FollowingPage() {
  const t = useTranslations('following')
  const [search] = useSearchParams()
  const asked = search.get('tab')
  const tab: Tab = asked === 'recs' || asked === 'likes' ? asked : 'all'
  const { locale } = useUi()
  const reading = useReading(locale)
  const { lang, never } = reading
  const tables = useTables()
  const { store } = useStore()
  const member = useMemberControls()
  const now = useNow()
  const { feed, more, busy, retry } = useFeed(tab, lang)
  const people = followedPeople(tables, (id) => store.person(id))
  const suggested = useSuggested(reading)
  const reasonText = useReasonText()
  useTitle(t('title'))

  // The people this page shows: a follow from here is named by them until the pull comes.
  useEffect(() => {
    store.rememberPeople(feed.items.map((i) => i.person))
  }, [feed, store])
  useEffect(() => {
    store.rememberPeople(suggested.map((s) => s.person))
  }, [suggested, store])

  return (
    <main className="mx-auto grid w-full max-w-[1120px] flex-1 animate-fade grid-cols-1 items-start gap-12 px-4 pt-10 pb-24 md:px-12 md:pt-11 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-16">
      <div className="min-w-0" data-testid="following-page">
        <h1 className="m-0 mb-2 font-serif text-[40px] leading-[1.1] font-medium tracking-[-0.015em]">
          {t('title')}
        </h1>
        <p className="mt-0 mb-7 text-[15px] leading-normal text-ink-2">{t('intro')}</p>
        <nav className="flex gap-6 border-b border-line" aria-label={t('title')}>
          {TABS.map((k) => (
            <Link
              key={k}
              to={k === 'all' ? '/following' : `/following?tab=${k}`}
              replace
              aria-current={k === tab ? 'page' : undefined}
              className={`-mb-px border-b-2 py-2.5 font-medium hover:text-ink hover:no-underline ${
                k === tab ? 'border-ink text-ink' : 'border-transparent text-muted'
              }`}
              data-testid={`following-tab-${k}`}
            >
              {t(`tabs.${k}`)}
            </Link>
          ))}
        </nav>
        {feed.status === 'loading' ? (
          <div className="py-12" aria-busy="true" data-testid="following-loading" />
        ) : feed.status === 'failed' ? (
          <div className="py-12 text-center text-muted" data-testid="following-failed">
            <p>{t('failed')}</p>
            <button type="button" onClick={retry} className="mt-2 underline">
              {t('retry')}
            </button>
          </div>
        ) : feed.items.length === 0 && feed.next === null ? (
          <p className="py-12 text-center text-muted" data-testid="following-empty">
            {t('empty')}
          </p>
        ) : (
          <div data-testid="following-items">
            {feed.items.map((item) => (
              <Activity
                key={item.key}
                item={item}
                member={member}
                lang={lang}
                never={never}
                locale={locale}
                now={now}
              />
            ))}
            {feed.next !== null ? (
              <div className="pt-8 text-center">
                <button
                  type="button"
                  onClick={() => void more()}
                  disabled={busy}
                  className="rounded-full border border-thumb px-4 py-2 text-[13px] font-medium text-ink hover:border-ink disabled:opacity-60"
                  data-testid="following-older"
                >
                  {t('older')}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <aside className="flex flex-col gap-9 lg:sticky lg:top-24">
        <section className="flex flex-col gap-1" data-testid="people-you-follow">
          <h2 className="m-0 mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            {t('peopleYouFollow')}
          </h2>
          {people.length === 0 ? (
            <p className="m-0 text-[13px] text-muted">{t('noOneYet')}</p>
          ) : (
            people.map((p) => (
              <Link
                key={p.id}
                to={`/@${p.handle}`}
                className="-mx-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-ink hover:bg-hover hover:no-underline"
              >
                <PersonAvatar
                  handle={p.handle}
                  displayName={p.displayName}
                  avatar={p.avatar}
                  size={28}
                />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {p.displayName ?? p.handle}
                </span>
                <span className="text-[12.5px] text-muted">@{p.handle}</span>
              </Link>
            ))
          )}
        </section>
        {suggested.length > 0 && member ? (
          <section className="flex flex-col gap-4" data-testid="readers-to-follow">
            <h2 className="m-0 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              {t('readersToFollow')}
            </h2>
            {suggested.map(({ person: p, reason }) => (
              <div
                key={p.id}
                className="flex items-start gap-3"
                data-testid="suggested-reader"
                data-handle={p.handle}
              >
                <Link to={`/@${p.handle}`} className="hover:no-underline">
                  <PersonAvatar
                    handle={p.handle}
                    displayName={p.displayName}
                    avatar={p.avatar}
                    size={32}
                  />
                </Link>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link to={`/@${p.handle}`} className="font-medium text-ink hover:underline">
                    {p.displayName ?? `@${p.handle}`}
                  </Link>
                  <ReasonDot text={reasonText(reason, reading)} />
                  {p.bio ? (
                    <div className="line-clamp-2 text-[12.5px] leading-[1.4] text-ink-2">
                      {p.bio}
                    </div>
                  ) : null}
                </div>
                <FollowButton person={p} member={member} next="/following" small />
              </div>
            ))}
          </section>
        ) : null}
      </aside>
    </main>
  )
}

/** A post's title as the member reads it: translated unless its language is one they read. */
function titleOf(post: Post, lang: string, never: readonly string[]) {
  const source = post.article.sourceLang
  const translate = source !== null && source !== lang && !never.includes(source)
  const title = translate ? (post.translatedTitle ?? post.article.title) : post.article.title
  const excerpt = translate
    ? (post.translatedExcerpt ?? post.article.excerpt)
    : post.article.excerpt
  const badge =
    translate && post.translatedTitle ? `${languageBadge(source)} → ${languageBadge(lang)}` : null
  return { title, excerpt, badge }
}

function Activity({
  item,
  member,
  lang,
  never,
  locale,
  now,
}: {
  item: FeedItem
  member: MemberControls | undefined
  lang: string
  never: readonly string[]
  locale: string
  now: number
}) {
  const t = useTranslations('following')
  const tc = useTranslations('common')
  const { person } = item
  const profile = `/@${person.handle}`
  const verb =
    item.kind === 'recommended'
      ? t('recommended')
      : item.kind === 'liked'
        ? t('liked', { n: item.count })
        : t('subscribed', { n: item.count })
  return (
    <article
      className="grid animate-fade grid-cols-[40px_minmax(0,1fr)] gap-4 border-b border-line py-7"
      data-testid="following-item"
      data-kind={item.kind}
    >
      <Link to={profile} className="hover:no-underline" aria-hidden="true" tabIndex={-1}>
        <PersonAvatar
          handle={person.handle}
          displayName={person.displayName}
          avatar={person.avatar}
          size={40}
        />
      </Link>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-1.5 pt-0.5 text-[14px]">
          <Link to={profile} className="font-semibold text-ink hover:underline">
            {person.displayName ?? `@${person.handle}`}
          </Link>
          <span className="text-ink-2">{verb}</span>
          <span className="text-muted">· {relativeTime(item.at, locale, now)}</span>
        </div>
        {item.kind === 'recommended' ? (
          <>
            {item.note ? (
              <p
                className="m-0 font-serif text-[21px] leading-[1.4] italic"
                style={{ textWrap: 'pretty' }}
                data-testid="following-note"
              >
                {tc('quoted', { text: item.note })}
              </p>
            ) : null}
            <PostCard post={item.post} member={member} lang={lang} never={never} />
          </>
        ) : item.kind === 'liked' ? (
          <ul className="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-line bg-surface p-0">
            {item.posts.map((post, i) => {
              const source = post.siteTitle ?? displayHost(post.homeUrl)
              return (
                <li
                  key={post.article.id}
                  className={`relative flex min-w-0 items-center gap-3 px-[18px] py-[13px] hover:bg-paper ${i > 0 ? 'border-t border-line' : ''}`}
                >
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ background: swatchColor(post.article.feedId) }}
                  />
                  <PostLink
                    article={heldArticle(post, lang)}
                    source={source}
                    member={member}
                    className="min-w-0 flex-1 truncate font-serif text-[18px] text-ink after:absolute after:inset-0 hover:no-underline"
                  >
                    {titleOf(post, lang, never).title}
                  </PostLink>
                  <span className="text-[12.5px] whitespace-nowrap text-muted">{source}</span>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="flex flex-col gap-2.5">
            {item.sites.map((site) => (
              <SiteRow key={site.id} site={site} member={member} />
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

/** The post to hold for the reader, with the title the feed showed in the member's language. */
const heldArticle = (post: Post, lang: string) =>
  post.translatedTitle
    ? { ...post.article, titles: { [lang]: post.translatedTitle } }
    : post.article

function PostCard({
  post,
  member,
  lang,
  never,
}: {
  post: Post
  member: MemberControls | undefined
  lang: string
  never: readonly string[]
}) {
  const t = useTranslations('following')
  const source = post.siteTitle ?? displayHost(post.homeUrl)
  const { title, excerpt, badge } = titleOf(post, lang, never)
  return (
    <div className="relative flex flex-col gap-2 rounded-xl border border-line bg-surface px-5 py-[18px] transition-colors hover:border-muted">
      <div className="flex items-center gap-2 text-[12.5px] text-muted">
        <span
          aria-hidden="true"
          className="flex size-4 items-center justify-center rounded text-[9px] font-semibold text-white"
          style={{ background: swatchColor(post.article.feedId) }}
        >
          {source.charAt(0).toUpperCase()}
        </span>
        <span className="font-medium text-ink">{source}</span>
        {badge ? (
          <span className="rounded border border-line px-[5px] text-[10.5px]">{badge}</span>
        ) : null}
      </div>
      <h3 className="m-0 font-serif text-[23px] leading-[1.2] font-medium tracking-[-0.005em]">
        <PostLink
          article={heldArticle(post, lang)}
          source={source}
          member={member}
          className="text-ink after:absolute after:inset-0 hover:no-underline"
        >
          {title}
        </PostLink>
      </h3>
      {excerpt ? (
        <p className="m-0 line-clamp-2 font-serif text-[16.5px] leading-[1.45] text-ink-2">
          {excerpt}
        </p>
      ) : null}
      <div className="mt-0.5 flex gap-3 text-[12px] text-muted">
        <span>{t('minutes', { n: post.article.readingMinutes || 1 })}</span>
        <span>♡ {post.article.likeCount}</span>
        <span className="flex-1" />
        <span className="font-medium text-ink">{t('read')}</span>
      </div>
    </div>
  )
}

function SiteRow({ site, member }: { site: Site; member: MemberControls | undefined }) {
  const td = useTranslations('discover')
  const title = site.title ?? displayHost(site.homeUrl)
  const subscribed = site.feedId !== null && member?.isSubscribed(site.feedId) === true
  return (
    <div className="flex flex-wrap items-center gap-3.5 rounded-xl border border-line bg-surface px-[18px] py-4">
      <SiteAvatar id={site.id} title={title} faviconKey={site.faviconKey} size={40} />
      <div className="min-w-[180px] flex-1">
        <Link to={`/s/${site.id}`} className="font-medium text-ink hover:underline">
          {title}
        </Link>
        {site.description ? (
          <div className="mt-0.5 line-clamp-2 font-serif text-[16px] text-ink-2">
            {site.description}
          </div>
        ) : null}
      </div>
      {site.feedId !== null && member ? (
        <button
          type="button"
          aria-pressed={subscribed}
          onClick={() => member.toggle(site.feedId as number, subscribed)}
          className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium ${
            subscribed ? 'border-thumb text-ink-2' : 'border-ink bg-ink text-paper'
          }`}
          data-testid="following-subscribe"
        >
          {subscribed ? td('subscribed') : td('subscribe')}
        </button>
      ) : null}
    </div>
  )
}
