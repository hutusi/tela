import {
  COMMUNITY_LISTING_MIN_READERS,
  LANGUAGE_NAMES,
  languageBadge,
  type ReadingLanguage,
  type UiLocale,
} from '@tela/shared'
import { type ReactNode, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { blogsApiPath } from '../lib/discover-href'
import { displayHost } from '../lib/format'
import { useMemberControls } from '../lib/member'
import { useBottomBar } from '../lib/use-bottom-bar'
import { BELOW_MD, useMediaQuery } from '../lib/use-media'
import { usePublic } from '../lib/use-public'
import type { DiscoverData, DiscoverSite, MemberControls } from '../views/types'
import { SiteAvatar } from './site-avatar'

/** Discover's Blogs page, page 1: its endpoint, so the first run and that tab share one answer. */
const BLOGS = blogsApiPath({ topic: null, lang: null, page: 1 })
const CARDS = 6

/** A link in a line of muted text: ink, underlined, as v5 draws the import line. */
const INLINE = 'text-ink underline underline-offset-[3px]'

/**
 * Whether Reading shows the first run in place of the list: for a member whose rows have arrived
 * (so it cannot flash before the first pull) and who follows nothing, or one it was already shown
 * to (`latched`) until they start reading; never over an open article, and never on Liked, which
 * holds what the member kept whether or not they still follow its blog.
 */
export function showsFirstRun(s: {
  synced: boolean
  subscriptions: number
  open: boolean
  filter: string
  latched: boolean
}): boolean {
  if (s.open || s.filter === 'liked') return false
  return s.latched || (s.synced && s.subscriptions === 0)
}

/**
 * Reading for a member who follows nothing yet (Tela v5), in place of an empty list and pane:
 * six blogs from the first page of Discover's Blogs, which puts the featured ones first, each with
 * a Subscribe that flips where it is. It stays up however many the member takes, until they say
 * they are done (`onStart`); offline, or with nothing to offer, it points at Discover and at
 * adding a blog by its address.
 *
 * On a phone (below `md`, Tela Mobile 16) the six are rows rather than cards, and Start is a bar
 * fixed at the foot, where a thumb reaches it however far the list scrolls. Rows or cards, the bar
 * or the ruled row: one of each renders, never both with one hidden, since both hold the same test
 * ids and the bar sets `--bottom-bar`.
 */
export function FirstRun({
  readingLang,
  locale,
  subscribed,
  onStart,
}: {
  readingLang: ReadingLanguage
  locale: string
  /** How many blogs the member follows now, those taken here included. */
  subscribed: number
  onStart: () => void
}) {
  const t = useTranslations('firstRun')
  const member = useMemberControls()
  const loaded = usePublic<DiscoverData>(BLOGS)
  // The six as first shown, kept: a Subscribe flips its own button and moves nothing, even if
  // the page is asked for again meanwhile and comes back in another order.
  const [sites, setSites] = useState<DiscoverSite[] | null>(null)
  if (sites === null && loaded.status === 'ready') {
    setSites(loaded.data.sites.filter((s) => s.feedId !== null).slice(0, CARDS))
  }
  const phone = useMediaQuery(BELOW_MD)
  const language = (LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en)[readingLang]
  // Nothing to offer here: the request failed (offline, an error), or there was nothing listed.
  const none =
    loaded.status === 'missing' ||
    (loaded.status === 'loading' && loaded.failed === true) ||
    sites?.length === 0
  const link = (to: string) => (chunks: ReactNode) => (
    <Link to={to} className={INLINE}>
      {chunks}
    </Link>
  )
  return (
    <main
      // The foot clears the phone's Start bar while it shows (`--bottom-bar`).
      className="w-full min-w-0 max-w-[1000px] px-5 pb-[calc(1.5rem+var(--bottom-bar,0px))] pt-[26px] animate-fade md:pb-16 md:pt-8 lg:px-12 lg:pb-24 lg:pt-12"
      data-testid="first-run"
    >
      <h1 className="m-0 mb-1.5 font-serif text-[30px] font-medium leading-[1.1] tracking-[-0.015em] md:mb-2 md:text-[36px]">
        {t('title')}
      </h1>
      <p
        className="m-0 mb-2.5 max-w-[560px] text-[14.5px] leading-normal text-ink-2 md:mb-7 md:text-[15px]"
        style={{ textWrap: 'pretty' }}
      >
        {t('intro', { language: language ?? readingLang })}
      </p>
      {none ? null : phone ? (
        <div className="flex flex-col">
          {sites
            ? sites.map((site) => <BlogRow key={site.id} site={site} member={member} />)
            : Array.from({ length: CARDS }, (_, i) => <RowPlaceholder key={String(i)} />)}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
          {sites
            ? sites.map((site) => <BlogCard key={site.id} site={site} member={member} />)
            : Array.from({ length: CARDS }, (_, i) => <CardPlaceholder key={String(i)} />)}
        </div>
      )}
      {phone ? (
        <>
          <p
            className="m-0 pt-4 text-[13px] leading-[1.6] text-muted"
            data-testid="first-run-footer"
          >
            {t.rich('footer', {
              discover: (chunks) => (
                <Link to="/discover/blogs" className={INLINE} data-testid="first-run-discover">
                  {chunks}
                </Link>
              ),
              opml: link('/add'),
              add: link('/add'),
            })}
          </p>
          {/* Nothing to offer and nothing taken: nothing to start or wait for. */}
          {subscribed > 0 || !none ? <StartBar subscribed={subscribed} onStart={onStart} /> : null}
        </>
      ) : (
        <>
          <div className="mt-7 flex flex-wrap items-center gap-4 border-t border-line pt-6">
            {subscribed > 0 ? (
              <button
                type="button"
                onClick={onStart}
                className="cursor-pointer rounded-full bg-primary px-[18px] py-2.5 font-medium text-on-primary hover:brightness-120"
                data-testid="first-run-start"
              >
                {t('start', { n: subscribed })}
              </button>
            ) : none ? null : (
              <span className="text-[13.5px] text-muted">{t('waiting')}</span>
            )}
            <span className="flex-1" />
            <Link
              to="/discover/blogs"
              className="text-[13.5px] font-medium text-ink hover:underline"
              data-testid="first-run-discover"
            >
              {t('more')}
            </Link>
          </div>
          <p className="m-0 mt-[18px] text-[13px] text-muted">
            {t.rich('import', { opml: link('/add'), add: link('/add') })}
          </p>
        </>
      )}
    </main>
  )
}

/**
 * Start, fixed at the foot of a phone's screen (Tela Mobile 16), or what it waits for while the
 * member has taken nothing. It is put in the body, as the reader's bar is: the page fades in on a
 * transform, which would hold a `fixed` bar to the page. While it shows, `--bottom-bar` says how
 * tall it is, so the page's foot clears it. Under the sticky header (`z-[9]`), so the account
 * menu opens over it.
 */
function StartBar({ subscribed, onStart }: { subscribed: number; onStart: () => void }) {
  const t = useTranslations('firstRun')
  const bar = useRef<HTMLDivElement>(null)
  useBottomBar(bar)
  return createPortal(
    <div
      ref={bar}
      className="fixed inset-x-0 bottom-0 z-[9] border-t border-line bg-paper px-5 pb-[max(30px,env(safe-area-inset-bottom))] pt-3"
      data-testid="first-run-bar"
    >
      {/* The waiting line is as tall as the pill, so the bar keeps its height when it turns. */}
      {subscribed > 0 ? (
        <button
          type="button"
          onClick={onStart}
          className="flex min-h-12 w-full cursor-pointer items-center justify-center rounded-full bg-primary px-5 font-medium text-on-primary hover:brightness-120"
          data-testid="first-run-start"
        >
          {t('start', { n: subscribed })}
        </button>
      ) : (
        <p className="m-0 flex min-h-12 items-center justify-center text-center text-[13.5px] text-muted">
          {t('waiting')}
        </p>
      )}
    </div>,
    document.body,
  )
}

/**
 * One of the six: a card of its own rather than Discover's `SiteCard`, which says more (the
 * latest post, how often it writes) and links away; here the member stays to choose.
 */
function BlogCard({ site, member }: { site: DiscoverSite; member: MemberControls | undefined }) {
  const t = useTranslations('discover')
  const title = site.title ?? displayHost(site.homeUrl)
  const { feedId } = site
  const on = feedId !== null && member?.isSubscribed(feedId) === true
  // Kept back below three readers (ADR 0041): tela-api sends none, and the card says nothing.
  const readers =
    site.readerCount !== null && site.readerCount >= COMMUNITY_LISTING_MIN_READERS
      ? t('readers', { n: site.readerCount })
      : null
  return (
    <div
      className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-surface p-[18px]"
      data-testid="first-run-card"
      data-site-id={site.id}
    >
      <div className="flex min-w-0 items-center gap-3">
        <SiteAvatar id={site.id} title={title} faviconKey={site.faviconKey} size={36} radius={9} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{title}</div>
          <div className="truncate text-[12.5px] text-muted">{displayHost(site.homeUrl)}</div>
        </div>
        {site.primaryLang ? (
          <span className="shrink-0 rounded border border-line px-1.5 text-[11px] text-muted">
            {languageBadge(site.primaryLang)}
          </span>
        ) : null}
      </div>
      {site.description ? (
        <p
          className="m-0 line-clamp-3 font-serif text-[16.5px] leading-[1.4] text-ink-2"
          style={{ textWrap: 'pretty' }}
        >
          {site.description}
        </p>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2 pt-0.5">
        <span className="text-[12.5px] text-muted">{readers}</span>
        {member && feedId !== null ? (
          <button
            type="button"
            onClick={() => member.toggle(feedId, on)}
            aria-pressed={on}
            className={`cursor-pointer whitespace-nowrap rounded-full border px-3.5 py-1.5 text-[13px] font-medium hover:brightness-95 ${
              on ? 'border-thumb bg-transparent text-ink-2' : 'border-ink bg-ink text-paper'
            }`}
            data-testid="first-run-subscribe"
          >
            {on ? t('subscribed') : t('subscribe')}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One of the six on a phone: a row, as v5 draws them, with the language beside the name and the
 * description cut to one line; no host and no readers, which a card has room for.
 */
function BlogRow({ site, member }: { site: DiscoverSite; member: MemberControls | undefined }) {
  const t = useTranslations('discover')
  const title = site.title ?? displayHost(site.homeUrl)
  const { feedId } = site
  const on = feedId !== null && member?.isSubscribed(feedId) === true
  return (
    <div
      className="flex min-w-0 items-center gap-3 border-b border-line py-3.5"
      data-testid="first-run-card"
      data-site-id={site.id}
    >
      <SiteAvatar
        id={site.id}
        title={title}
        faviconKey={site.faviconKey}
        size={40}
        radius={10}
        className="!text-[17px]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 font-medium">
          <span className="truncate">{title}</span>
          {site.primaryLang ? (
            <span className="shrink-0 rounded border border-line px-[5px] text-[10.5px] font-normal text-muted">
              {languageBadge(site.primaryLang)}
            </span>
          ) : null}
        </div>
        {site.description ? (
          <div className="truncate text-[13px] text-ink-2">{site.description}</div>
        ) : null}
      </div>
      {member && feedId !== null ? (
        <button
          type="button"
          onClick={() => member.toggle(feedId, on)}
          aria-pressed={on}
          className={`shrink-0 cursor-pointer whitespace-nowrap rounded-full border bg-transparent px-3.5 py-[7px] text-[13px] font-medium hover:bg-hover ${
            on ? 'border-thumb text-ink-2' : 'border-ink text-ink'
          }`}
          data-testid="first-run-subscribe"
        >
          {on ? t('subscribed') : t('subscribe')}
        </button>
      ) : null}
    </div>
  )
}

/** A row's shape while the blogs are on their way. */
function RowPlaceholder() {
  return (
    <div aria-hidden className="flex items-center gap-3 border-b border-line py-3.5">
      <div className="size-10 shrink-0 rounded-[10px] bg-hover" />
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="h-3 w-1/2 rounded bg-hover" />
        <div className="h-2.5 w-3/4 rounded bg-hover" />
      </div>
    </div>
  )
}

/** A card's shape while the blogs are on their way. */
function CardPlaceholder() {
  return (
    <div
      aria-hidden
      className="flex min-h-[184px] flex-col gap-3 rounded-xl border border-line bg-surface p-[18px]"
    >
      <div className="flex items-center gap-3">
        <div className="size-9 shrink-0 rounded-[9px] bg-hover" />
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="h-3 w-1/2 rounded bg-hover" />
          <div className="h-2.5 w-1/3 rounded bg-hover" />
        </div>
      </div>
      <div className="h-3.5 w-11/12 rounded bg-hover" />
      <div className="h-3.5 w-3/4 rounded bg-hover" />
    </div>
  )
}
