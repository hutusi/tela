/**
 * A post on Discover (ADR 0044): This week's lead, the four ranked under it, and Articles' rows.
 * Each opens through `PostLink`: a member's in the reader, a visitor's on the blog itself. The
 * title and excerpt show in the reader's language as public pages show them (`publicTitle`); a
 * reader's note shows as they wrote it. Why it is here (someone the member follows recommends it,
 * or how many readers did this week) comes from the device, in `followed`.
 */
import { Fragment } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { type PostReason, postReason } from '../lib/discover-overlay'
import { bylineName } from '../lib/edition'
import { displayHost, relativeTime, swatchColor } from '../lib/format'
import { publicExcerpt, publicTitle } from '../lib/public-title'
import { PostLink } from '../views/post-link'
import type { DiscoverPost, MemberControls, Person, PublicArticle, Reading } from '../views/types'
import { PersonAvatar } from './person-avatar'

/** A link that sits above the title's, which is stretched over the whole post. */
const ABOVE = 'relative z-[1]'

export type DiscoverPostProps = {
  post: DiscoverPost
  member: MemberControls | undefined
  reading: Reading
  locale: string
  now: number
  /** The people the member follows among its recommenders; none for a visitor. */
  followed: readonly Person[]
}

const blogName = (post: DiscoverPost) => post.site.title ?? displayHost(post.site.homeUrl)
const personName = (p: Person) => p.displayName ?? `@${p.handle}`

/** The language a title shows in: the reader's when `publicTitle` gave its translation. */
function titleLang(a: PublicArticle, reading: Reading): string | undefined {
  const source = a.sourceLang
  if (!source) return undefined
  const translated =
    source !== reading.lang && !reading.never.includes(source) && Boolean(a.titles?.[reading.lang])
  return translated ? reading.lang : source
}

/** The language an excerpt from `publicExcerpt` is in: translated, or as written. */
function excerptLang(a: PublicArticle, excerpt: string, reading: Reading): string | undefined {
  return excerpt !== a.excerpt ? reading.lang : (a.sourceLang ?? undefined)
}

/** The blog's swatch and name, then whatever else the variant says, then the language badge. */
function Meta({
  post,
  parts,
  badge,
}: {
  post: DiscoverPost
  parts: (string | null)[]
  badge: string | null
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-muted">
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-[3px]"
        style={{ background: swatchColor(post.article.feedId) }}
      />
      <Link
        to={`/s/${post.site.id}`}
        className={`${ABOVE} font-medium text-ink hover:text-ink hover:underline`}
      >
        {blogName(post)}
      </Link>
      {parts
        .filter((part) => part !== null)
        .map((part) => (
          <Fragment key={part}>
            <span aria-hidden="true">·</span>
            <span className="whitespace-nowrap">{part}</span>
          </Fragment>
        ))}
      {badge ? (
        <span className="rounded border border-line px-[5px] text-[10.5px] whitespace-nowrap">
          {badge}
        </span>
      ) : null}
    </div>
  )
}

/** "Anna, whom you follow, recommended it", or "Recommended by 4 readers this week". */
export function ReasonLine({ reason }: { reason: PostReason }) {
  const t = useTranslations('discover')
  if (!reason) return null
  let text: string
  if (reason.kind === 'week') text = t('reason.week', { n: reason.count })
  else {
    const [first] = reason.people
    const name = first ? personName(first) : ''
    // Everyone else who recommends it, whom the member follows or not.
    const others = reason.others + reason.people.length - 1
    text =
      others > 0 ? t('reason.followedOthers', { name, n: others }) : t('reason.followed', { name })
  }
  return (
    <div
      className="flex items-baseline gap-2 text-[12.5px] leading-[1.4] text-ink-2"
      data-testid="post-reason"
    >
      <span
        aria-hidden="true"
        className="size-[5px] shrink-0 -translate-y-0.5 rounded-full bg-accent"
      />
      <span>{text}</span>
    </div>
  )
}

/** "“A lovely read.” — Anna": the newest note, as its reader wrote it. */
function NoteLine({ note }: { note: NonNullable<DiscoverPost['note']> }) {
  const t = useTranslations('discover')
  const tc = useTranslations('common')
  return (
    <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1" data-testid="post-note">
      <span className="font-serif text-[17px] leading-[1.4] text-ink italic">
        {tc('quoted', { text: note.text })}
      </span>
      <Link
        to={`/@${note.person.handle}`}
        className={`${ABOVE} text-[12.5px] whitespace-nowrap text-muted hover:text-ink hover:no-underline`}
      >
        {t('noteBy', { name: personName(note.person) })}
      </Link>
    </div>
  )
}

/** Subscribe or Subscribed to the post's feed; a visitor's signs in first and comes back. */
function Subscribe({
  feedId,
  member,
  next,
}: {
  feedId: number
  member: MemberControls | undefined
  next: string
}) {
  const t = useTranslations('discover')
  const shape = 'rounded-full border px-4 py-[7px] text-[13px] font-medium'
  if (!member) {
    return (
      <Link
        to={`/login?next=${encodeURIComponent(next)}`}
        className={`${shape} border-line text-ink hover:border-ink hover:text-ink hover:no-underline`}
      >
        {t('subscribe')}
      </Link>
    )
  }
  const subscribed = member.isSubscribed(feedId)
  return (
    <button
      type="button"
      onClick={() => member.toggle(feedId, subscribed)}
      aria-pressed={subscribed}
      data-testid="site-subscribe"
      className={`${shape} hover:border-ink ${subscribed ? 'border-line text-ink-2' : 'border-ink text-ink'}`}
    >
      {subscribed ? t('subscribed') : t('subscribe')}
    </button>
  )
}

/** This week's first post, large, beside its note and how many recommended it. */
export function LeadPost({
  post,
  member,
  reading,
  locale,
  now,
  followed,
  next,
}: DiscoverPostProps & {
  /** Where a visitor's Subscribe comes back to. */
  next: string
}) {
  const t = useTranslations('discover')
  const tc = useTranslations('common')
  const { article, note } = post
  const shown = publicTitle(article, reading)
  const excerpt = publicExcerpt(article, reading)
  const source = blogName(post)
  const reason = postReason(post, followed)
  // Everyone who recommended it this week: the note shown may be older than the week, so its
  // reader is not taken off the count.
  const count = post.weekRecs > 0 ? t('week.readersRecommended', { n: post.weekRecs }) : null
  const line =
    reason?.kind === 'followed' ? (
      <ReasonLine reason={reason} />
    ) : count ? (
      <div className="text-[12.5px] text-muted">{count}</div>
    ) : null
  return (
    <article
      className="flex flex-wrap gap-x-14 gap-y-8 rounded-[14px] border border-line bg-surface p-5 animate-fade md:p-8"
      data-testid="week-lead"
      data-article-id={article.id}
      data-site-id={post.site.id}
    >
      <div className="flex min-w-0 flex-[1.5_1_380px] flex-col gap-3.5">
        <Meta
          post={post}
          parts={[
            bylineName(article.author, source),
            relativeTime(article.sortAt, locale, now),
            t('minutes', { n: article.readingMinutes || 1 }),
          ]}
          badge={shown.badge}
        />
        <h2
          lang={titleLang(article, reading)}
          className="m-0 font-serif text-[28px] leading-[1.1] font-medium tracking-[-0.015em] text-pretty md:text-[38px] md:leading-[1.08]"
        >
          <PostLink
            article={article}
            source={source}
            member={member}
            className="text-ink hover:text-ink hover:underline hover:decoration-1 hover:underline-offset-[3px]"
          >
            {shown.title}
          </PostLink>
        </h2>
        {excerpt ? (
          <p
            lang={excerptLang(article, excerpt, reading)}
            className="m-0 line-clamp-4 font-serif text-[17px] leading-[1.45] text-pretty text-ink-2 md:text-[18px]"
          >
            {excerpt}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2.5">
          <PostLink
            article={article}
            source={source}
            member={member}
            className="rounded-full border border-ink bg-ink px-[18px] py-[7px] text-[13px] font-medium text-paper hover:text-paper hover:no-underline hover:brightness-125"
          >
            {t('week.read')}
          </PostLink>
          <Subscribe feedId={article.feedId} member={member} next={next} />
        </div>
      </div>
      {note || line ? (
        <div className="flex min-w-0 flex-[1_1_260px] flex-col justify-center gap-6">
          {note ? (
            <div className="flex flex-col gap-2.5" data-testid="post-note">
              <p className="m-0 font-serif text-[20px] leading-[1.4] text-pretty text-ink italic">
                {tc('quoted', { text: note.text })}
              </p>
              <Link
                to={`/@${note.person.handle}`}
                className="flex items-center gap-2 self-start text-[13px] text-ink-2 hover:text-ink hover:no-underline"
              >
                <PersonAvatar
                  handle={note.person.handle}
                  displayName={note.person.displayName}
                  avatar={note.person.avatar}
                  size={22}
                />
                {personName(note.person)}
              </Link>
            </div>
          ) : null}
          {line ? <div className={note ? 'border-t border-line pt-4' : ''}>{line}</div> : null}
        </div>
      ) : null}
    </article>
  )
}

/** This week's second to fifth: a rank, the blog, the title and why it is here. */
export function RankedPost({
  post,
  rank,
  member,
  reading,
  followed,
}: DiscoverPostProps & { rank: number }) {
  const t = useTranslations('discover')
  const { article } = post
  const shown = publicTitle(article, reading)
  return (
    <article
      className="relative grid grid-cols-[22px_minmax(0,1fr)] items-start gap-3.5 border-b border-line py-[22px] animate-fade"
      data-testid="discover-post"
      data-article-id={article.id}
      data-site-id={post.site.id}
    >
      <span className="font-serif text-[20px] leading-[1.2] text-muted">{rank}</span>
      <div className="flex min-w-0 flex-col gap-2">
        <Meta
          post={post}
          parts={[t('minutes', { n: article.readingMinutes || 1 })]}
          badge={shown.badge}
        />
        <h3
          lang={titleLang(article, reading)}
          className="m-0 font-serif text-[20px] leading-[1.2] font-medium text-pretty md:text-[22px]"
        >
          <PostLink
            article={article}
            source={blogName(post)}
            member={member}
            className="text-ink after:absolute after:inset-0 hover:text-ink hover:underline hover:decoration-1 hover:underline-offset-[3px]"
          >
            {shown.title}
          </PostLink>
        </h3>
        <ReasonLine reason={postReason(post, followed)} />
      </div>
    </article>
  )
}

/** A post in Articles: who wrote it and when, the title, two lines of excerpt, why, and a note. */
export function PostRow({ post, member, reading, locale, now, followed }: DiscoverPostProps) {
  const t = useTranslations('discover')
  const { article, note } = post
  const shown = publicTitle(article, reading)
  const excerpt = publicExcerpt(article, reading)
  const source = blogName(post)
  return (
    <article
      className="relative border-b border-line py-[26px] animate-fade"
      data-testid="discover-post"
      data-article-id={article.id}
      data-site-id={post.site.id}
    >
      <div className="flex max-w-[740px] min-w-0 flex-col gap-[9px]">
        <Meta
          post={post}
          parts={[
            bylineName(article.author, source),
            relativeTime(article.sortAt, locale, now),
            t('minutes', { n: article.readingMinutes || 1 }),
          ]}
          badge={shown.badge}
        />
        <h3
          lang={titleLang(article, reading)}
          className="m-0 font-serif text-[22px] leading-[1.18] font-medium tracking-[-0.005em] text-pretty md:text-[25px]"
        >
          <PostLink
            article={article}
            source={source}
            member={member}
            className="text-ink after:absolute after:inset-0 hover:text-ink hover:underline hover:decoration-1 hover:underline-offset-[3px]"
          >
            {shown.title}
          </PostLink>
        </h3>
        {excerpt ? (
          <p
            lang={excerptLang(article, excerpt, reading)}
            className="m-0 line-clamp-2 font-serif text-[16px] leading-[1.45] text-ink-2 md:text-[17px]"
          >
            {excerpt}
          </p>
        ) : null}
        <ReasonLine reason={postReason(post, followed)} />
        {note ? <NoteLine note={note} /> : null}
      </div>
    </article>
  )
}
