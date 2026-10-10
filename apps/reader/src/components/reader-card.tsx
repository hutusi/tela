/**
 * A reader Discover suggests following (ADR 0044): who they are, why they are suggested, and one
 * note of theirs, which opens the post it was written on. A row in the Readers tab, a card in
 * This week. The reason comes from `suggestReaders`, matched on the device.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { displayHost } from '../lib/format'
import { publicTitle } from '../lib/public-title'
import type { ReaderReason, Suggestion } from '../lib/suggest-readers'
import { PostLink } from '../views/post-link'
import type { MemberControls, ReaderPost, Reading } from '../views/types'
import { FollowButton } from './follow-button'
import { PersonAvatar } from './person-avatar'

const blogOf = (p: ReaderPost) => p.site.title ?? displayHost(p.site.homeUrl)

/** Why a reader is suggested, in the member's words for it. */
export function useReasonText(): (reason: ReaderReason, reading: Reading) => string {
  const t = useTranslations('discover.people.reasons')
  return (reason, reading) => {
    switch (reason.kind) {
      case 'shared':
        return reason.count === 1 && reason.title
          ? t('shared.one', { title: reason.title })
          : t('shared.count', { n: reason.count })
      case 'blogs':
        return reason.count === 1 && reason.blog
          ? t(`blogs.${reason.via}.one`, { blog: reason.blog })
          : t(`blogs.${reason.via}.count`, { n: reason.count })
      case 'early':
        return t('early', {
          title: publicTitle(reason.post.article, reading).title,
          n: reason.others,
        })
      case 'notes':
        return reason.withNote >= reason.recent
          ? t('notes.all', { n: reason.recent })
          : t('notes.some', { k: reason.withNote, n: reason.recent })
      case 'active':
        return t('active', { n: reason.recent })
    }
  }
}

export function ReasonDot({ text }: { text: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[12.5px] leading-[1.4] text-ink-2">
      <span
        aria-hidden="true"
        className="size-[5px] shrink-0 -translate-y-0.5 rounded-full bg-accent"
      />
      <span>{text}</span>
    </div>
  )
}

export function ReaderCard({
  suggestion,
  variant,
  member,
  reading,
  next,
}: {
  suggestion: Suggestion
  /** `row`: the Readers tab; `card`: This week's three. */
  variant: 'row' | 'card'
  member: MemberControls | undefined
  reading: Reading
  /** Where a visitor's Follow comes back to. */
  next: string
}) {
  const t = useTranslations('discover')
  const tc = useTranslations('common')
  const reasonText = useReasonText()
  const { person, reason } = suggestion
  const profile = `/@${person.handle}`
  const name = person.displayName ?? `@${person.handle}`
  const why = reasonText(reason, reading)
  const sample = person.sample
  const sampleTitle = sample ? publicTitle(sample.article, reading).title : null
  // The post's title, in the sentence about it, is the link, stretched over the whole sample.
  const sampleLink = (chunks: React.ReactNode) =>
    sample ? (
      <PostLink
        article={sample.article}
        source={blogOf(sample)}
        member={member}
        className="text-ink after:absolute after:inset-0 hover:text-ink hover:no-underline"
      >
        {chunks}
      </PostLink>
    ) : null

  if (variant === 'card') {
    return (
      <div
        className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 animate-fade"
        data-testid="reader-card"
        data-handle={person.handle}
      >
        <div className="flex items-start gap-3">
          <Link
            to={profile}
            className="shrink-0 hover:no-underline"
            tabIndex={-1}
            aria-hidden="true"
          >
            <PersonAvatar
              handle={person.handle}
              displayName={person.displayName}
              avatar={person.avatar}
              size={40}
            />
          </Link>
          <div className="min-w-0 flex-1 pt-px">
            <Link to={profile} className="font-semibold text-ink hover:text-ink hover:underline">
              {name}
            </Link>
            <div className="mt-0.5 text-[12.5px] leading-[1.4] text-ink-2">{why}</div>
          </div>
          <FollowButton person={person} member={member} next={next} small />
        </div>
        {person.bio ? (
          <p className="m-0 line-clamp-3 font-serif text-[16px] leading-[1.4] text-pretty text-ink-2">
            {person.bio}
          </p>
        ) : null}
        {sample ? (
          <div className="relative mt-auto flex flex-col gap-1.5 border-t border-line pt-3.5 hover:opacity-80">
            <p className="m-0 font-serif text-[17px] leading-[1.4] text-pretty text-ink italic">
              {tc('quoted', { text: sample.note })}
            </p>
            <div className="text-[12.5px] text-muted">
              {t.rich('week.sampleOn', {
                title: sampleTitle ?? '',
                b: sampleLink,
              })}
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className="grid grid-cols-[48px_minmax(0,1fr)] items-start gap-x-3.5 gap-y-3 border-b border-line py-6 animate-fade sm:grid-cols-[48px_minmax(0,1fr)_auto] sm:gap-x-[18px]"
      data-testid="reader-card"
      data-handle={person.handle}
    >
      <Link to={profile} className="hover:no-underline" tabIndex={-1} aria-hidden="true">
        <PersonAvatar
          handle={person.handle}
          displayName={person.displayName}
          avatar={person.avatar}
          size={48}
        />
      </Link>
      <div className="flex max-w-[660px] min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Link
            to={profile}
            className="text-[15px] font-semibold text-ink hover:text-ink hover:underline"
          >
            {name}
          </Link>
          <span className="text-[13px] text-muted">@{person.handle}</span>
        </div>
        {person.bio ? (
          <p className="m-0 font-serif text-[17px] leading-[1.4] text-pretty text-body md:text-[18px]">
            {person.bio}
          </p>
        ) : null}
        <ReasonDot text={why} />
        {sample ? (
          <div className="relative mt-2 flex flex-col gap-1.5 rounded-[10px] border border-line bg-surface px-4 py-3.5 transition-colors hover:border-thumb">
            <p className="m-0 font-serif text-[17px] leading-[1.4] text-pretty text-ink italic">
              {tc('quoted', { text: sample.note })}
            </p>
            <div className="text-[12.5px] text-muted">
              {t.rich('people.sample', {
                title: sampleTitle ?? '',
                blog: blogOf(sample),
                b: sampleLink,
              })}
            </div>
          </div>
        ) : null}
      </div>
      {/* Beside the name from `sm`; under the avatar on a phone, where the row has no room. */}
      <div className="col-start-2 sm:col-start-3 sm:row-start-1">
        <FollowButton person={person} member={member} next={next} />
      </div>
    </div>
  )
}
