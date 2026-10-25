/**
 * A blogroll's page (ADR 0050), pure so the edge renders it too: a guest's view of a public
 * blogroll, a member's, and its owner's, which the page fills with its tools through the slots.
 * Layout by CSS alone (`max-md:`), since the edge has no media queries.
 *
 * From the design (Tela Lists, the blogroll page and screen 24): a centred header, the eyebrow,
 * the name in the serif, the description, the owner and how many blogs, then what the reader can
 * do; under it each blog, with its language, its address and readers, its own line about itself,
 * and the owner's note. Names, descriptions and notes are shown as written, never translated.
 */
import { languageBadge } from '@tela/shared'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { FeedLinks } from '../components/feed-links'
import { CHECK, Glyph } from '../components/glyph'
import { PersonAvatar } from '../components/person-avatar'
import { SiteAvatar } from '../components/site-avatar'
import { daysAgo } from '../lib/days'
import { blogrollFeedHref } from '../lib/feed-href'
import { displayHost, relativeFormat, shortDate } from '../lib/format'
import type { BlogrollBlog, BlogrollData, MemberControls, Person } from './types'

/** What the owner's page puts into a row: its action (Remove) and its note, or the note editor. */
export type BlogrollRowSlots = { action?: ReactNode; note?: ReactNode; meta?: ReactNode }

export type BlogrollViewProps = {
  data: BlogrollData
  /** A signed-in visitor: their subscription state, and Subscribe on each row. */
  member?: MemberControls | undefined
  locale: string
  now: number
  /** The owner's tools under the title (Public, Edit, Add blogs, Copy link), and the Add blogs panel. */
  ownerHeader?: ReactNode
  /** The owner's slots for one row; given, the row shows them in place of Subscribe. */
  ownerRow?: (blog: BlogrollBlog) => BlogrollRowSlots
  /** The member's Subscribe to all, with its panel. Absent for a guest, who gets a sign-in link. */
  subscribe?: ReactNode
  /** Shown in place of the list when the blogroll has no blogs. */
  empty?: ReactNode
  /**
   * Nothing to press: the owner on a device that does not hold their blogroll yet (made on
   * another, and not pulled here), who sees it as others do until the pull brings it.
   */
  readOnly?: boolean | undefined
  /** A line under the list: the owner's says who can see the blogroll. */
  footer?: ReactNode
  /**
   * Its RSS and OPML (ADR 0062), the RSS's titles in `hl`: only while others can see it, since a
   * private blogroll's feeds are a 404.
   */
  feeds?: { hl: string | null } | undefined
}

/**
 * When a blogroll last changed, as its byline says it: today or yesterday in words, as a sentence
 * has them ("today", "hier", "今天"), else the date as a list's date column has it (`shortDate`),
 * with the year once it is not this one. Local days (`daysAgo`), as the reader lives them.
 */
export function updatedWhen(
  at: number,
  locale: string,
  now: number,
): { day: boolean; when: string } {
  const days = daysAgo(at, now)
  if (days <= 1) {
    return {
      day: true,
      when: relativeFormat(locale).format(-days, 'day'),
    }
  }
  return { day: false, when: shortDate(at, locale, now) }
}

/** The filled pill: Subscribe to all, and a guest's sign-in in its place. */
export const PRIMARY_PILL =
  'inline-flex items-center justify-center gap-[7px] rounded-full border border-primary bg-primary px-4 py-2 font-medium text-on-primary hover:no-underline disabled:opacity-60 max-md:min-h-11 max-md:w-full'

/** The outlined pill of the header's other buttons, and Subscribed to all. */
export const QUIET_PILL =
  'inline-flex items-center justify-center gap-[7px] rounded-full border border-thumb bg-transparent px-4 py-2 font-medium whitespace-nowrap text-ink hover:border-ink hover:no-underline disabled:opacity-60 disabled:hover:border-thumb aria-disabled:cursor-default aria-disabled:hover:border-thumb'

/** A row's Subscribe, outlined as a grid of choices is (Tela v5), and Remove the same. */
export const ROW_PILL =
  'inline-flex items-center gap-1.5 rounded-full border bg-transparent px-3.5 py-[7px] text-[13px] font-medium whitespace-nowrap text-ink transition-colors hover:bg-hover hover:no-underline'

/** Only a web address is a link: anything else a stored URL holds is shown, never followed. */
const isWeb = (url: string) => /^https?:\/\//i.test(url)

export function BlogrollView({
  data,
  member,
  locale,
  now,
  ownerHeader,
  ownerRow,
  subscribe,
  empty,
  readOnly = false,
  footer,
  feeds,
}: BlogrollViewProps) {
  const t = useTranslations('blogroll')
  const { blogroll, owner, blogs } = data
  const here = `/l/${blogroll.id}`
  const mine = ownerRow !== undefined || member?.userId === owner.id
  const updated = updatedWhen(blogroll.updatedAt, locale, now)
  const n = blogs.length

  // What the reader can do with the whole blogroll: the owner's tools, a member's Subscribe to
  // all, a guest's sign-in. Nothing to subscribe to in an empty one.
  const actions =
    ownerHeader ??
    (readOnly || n === 0
      ? null
      : (subscribe ??
        (member ? null : (
          <Link
            to={`/login?next=${encodeURIComponent(here)}`}
            className={PRIMARY_PILL}
            data-testid="blogroll-subscribe-all"
          >
            {t('subscribeAll', { n })}
          </Link>
        ))))

  return (
    <main
      className="mx-auto w-full max-w-[780px] flex-1 animate-fade px-5 pt-4 pb-24 md:px-12 md:pt-9"
      data-testid="blogroll-page"
      data-blogroll-id={blogroll.id}
    >
      <header className="flex flex-col items-center gap-3 border-b border-line pt-6 pb-7 text-center md:gap-4 md:pt-10 md:pb-9">
        <span className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
          {t('eyebrow')}
        </span>
        <h1
          className="m-0 max-w-full font-serif text-[38px] leading-[1.05] font-medium tracking-[-0.02em] [overflow-wrap:anywhere] md:text-[54px] md:leading-[1.04]"
          style={{ textWrap: 'balance' }}
        >
          {blogroll.name}
        </h1>
        {blogroll.description ? (
          <p
            className="m-0 max-w-[540px] font-serif text-[17.5px] leading-[1.45] whitespace-pre-line text-ink-2 [overflow-wrap:anywhere] md:text-[20px]"
            style={{ textWrap: 'pretty' }}
          >
            {blogroll.description}
          </p>
        ) : null}
        <div className="flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] text-muted">
          <Link
            to={`/@${owner.handle}`}
            className="inline-flex min-w-0 items-center gap-2 font-medium text-ink hover:underline"
            data-testid="blogroll-owner"
          >
            <PersonAvatar
              handle={owner.handle}
              displayName={owner.displayName}
              avatar={owner.avatar}
              size={24}
              me={mine}
            />
            <span className="[overflow-wrap:anywhere]">{personName(owner)}</span>
          </Link>
          <span aria-hidden="true">·</span>
          <span data-testid="blogroll-count">{t('blogs', { n })}</span>
          <span aria-hidden="true">·</span>
          <span>
            {updated.day
              ? t('updatedDay', { when: updated.when })
              : t('updatedOn', { when: updated.when })}
          </span>
        </div>
        {actions ? (
          <div className="mt-1.5 flex w-full flex-col items-center gap-3">{actions}</div>
        ) : null}
      </header>

      {n === 0 ? (
        (empty ?? (
          <p className="my-10 text-center text-[15px] text-muted" data-testid="blogroll-empty">
            {t('emptyVisitor')}
          </p>
        ))
      ) : (
        <ul className="m-0 list-none p-0" data-testid="blogroll-blogs">
          {blogs.map((blog) => (
            <BlogRow
              key={blog.feedId}
              blog={blog}
              owner={owner}
              mine={mine}
              here={here}
              member={member}
              readOnly={readOnly}
              slots={ownerRow?.(blog)}
            />
          ))}
        </ul>
      )}

      {footer ? (
        <p className="mt-8 mb-0 text-center text-[13.5px] text-muted" data-testid="blogroll-footer">
          {footer}
        </p>
      ) : null}

      {/* Its feeds hold its listed blogs only: with none, they would be empty. */}
      {feeds && blogs.some((b) => b.listed) ? (
        <FeedLinks
          rss={blogrollFeedHref(blogroll.id, 'rss', feeds.hl)}
          opml={blogrollFeedHref(blogroll.id, 'opml')}
          className="mt-8 text-center"
        />
      ) : null}
    </main>
  )
}

const personName = (p: Pick<Person, 'handle' | 'displayName'>) => p.displayName ?? `@${p.handle}`

function BlogRow({
  blog,
  owner,
  mine,
  here,
  member,
  readOnly,
  slots,
}: {
  blog: BlogrollBlog
  owner: Person
  mine: boolean
  here: string
  member: MemberControls | undefined
  readOnly: boolean
  slots: BlogrollRowSlots | undefined
}) {
  const td = useTranslations('discover')
  const ts = useTranslations('site')
  const tf = useTranslations('settings.folders')
  const host = blog.homeUrl ? displayHost(blog.homeUrl) : ''
  const name = blog.name ?? host
  const meta = [
    host,
    blog.readerCount === null ? null : ts('readersOnTela', { n: blog.readerCount }),
    blog.dead ? tf('notUpdating') : null,
  ].filter((part): part is string => Boolean(part))
  const subscribed = member?.isSubscribed(blog.feedId) === true

  let action: ReactNode = null
  if (slots) action = slots.action ?? null
  else if (readOnly) action = null
  else if (member) {
    action = (
      <button
        type="button"
        aria-pressed={subscribed}
        onClick={() => member.toggle(blog.feedId, subscribed)}
        className={`${ROW_PILL} ${subscribed ? 'border-thumb' : 'border-ink'}`}
        data-testid="blogroll-row-subscribe"
      >
        {subscribed ? (
          <Glyph size={12} strokeWidth={1.8} className="block shrink-0">
            {CHECK}
          </Glyph>
        ) : null}
        {subscribed ? td('subscribed') : td('subscribe')}
      </button>
    )
  } else {
    action = (
      <Link
        to={`/login?next=${encodeURIComponent(here)}`}
        className={`${ROW_PILL} border-ink`}
        data-testid="blogroll-row-subscribe"
      >
        {td('subscribe')}
      </Link>
    )
  }

  const nameClass = 'text-[15.5px] font-semibold text-ink [overflow-wrap:anywhere]'
  return (
    <li
      className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-start gap-x-[18px] border-b border-line py-7 max-md:grid-cols-[40px_minmax(0,1fr)] max-md:gap-x-3.5 max-md:py-5"
      data-testid="blogroll-row"
      data-feed-id={blog.feedId}
    >
      <SiteAvatar
        id={blog.siteId || blog.feedId}
        title={name || '?'}
        faviconKey={blog.faviconKey}
        size={48}
        radius={12}
        className="max-md:!size-10 max-md:!rounded-[10px] max-md:!text-[18px]"
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {blog.listed && blog.siteId > 0 ? (
            <Link to={`/s/${blog.siteId}`} className={`${nameClass} hover:underline`}>
              {name}
            </Link>
          ) : isWeb(blog.homeUrl) ? (
            <a
              href={blog.homeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${nameClass} hover:underline`}
            >
              {name}
            </a>
          ) : (
            // A blog the device holds no row for yet (the owner's, before the pull brings it).
            <span className={nameClass}>{name || '…'}</span>
          )}
          {blog.primaryLang ? (
            <span className="rounded border border-line px-[5px] text-[10.5px] text-muted">
              {languageBadge(blog.primaryLang)}
            </span>
          ) : null}
        </div>
        {meta.length > 0 || slots?.meta ? (
          <div className="text-[12.5px] text-muted [overflow-wrap:anywhere]">
            {meta.join(' · ')}
            {slots?.meta ? (
              <>
                {meta.length > 0 ? ' · ' : null}
                {slots.meta}
              </>
            ) : null}
          </div>
        ) : null}
        {blog.description ? (
          <p
            className="mt-0.5 mb-0 line-clamp-3 font-serif text-[17px] leading-[1.4] text-ink-2 [overflow-wrap:anywhere] max-md:text-[16px]"
            style={{ textWrap: 'pretty' }}
          >
            {blog.description}
          </p>
        ) : null}
        {slots?.note !== undefined ? (
          slots.note
        ) : blog.note ? (
          <BlogrollNoteText note={blog.note} owner={owner} me={mine} />
        ) : null}
      </div>
      {action ? (
        <div className="max-md:col-start-2 max-md:mt-2.5 max-md:justify-self-start">{action}</div>
      ) : null}
    </li>
  )
}

/** The owner's note on a blog: their small avatar beside it, in the serif's italic, quoted. */
export function BlogrollNoteText({
  note,
  owner,
  me,
}: {
  note: string
  owner: Pick<Person, 'handle' | 'displayName' | 'avatar'>
  me: boolean
}) {
  const tc = useTranslations('common')
  return (
    <span className="mt-1.5 flex items-start gap-2.5 text-left">
      <PersonAvatar
        handle={owner.handle}
        displayName={owner.displayName}
        avatar={owner.avatar}
        size={22}
        me={me}
        className="mt-[3px]"
      />
      <span
        className="min-w-0 font-serif text-[18px] leading-[1.45] whitespace-pre-line text-ink italic [overflow-wrap:anywhere] max-md:text-[17px]"
        style={{ textWrap: 'pretty' }}
      >
        {tc('quoted', { text: note })}
      </span>
    </span>
  )
}
