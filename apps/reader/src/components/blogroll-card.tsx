/**
 * A blogroll on a card (ADR 0050), on a profile's Blogrolls tab and on Discover's. Pure, so the
 * edge renders it too: what is the member's own (Private, why Discover shows it to them) comes in
 * by props. The whole card is the link to the blogroll's page, and nothing in it is a control.
 *
 * A profile's card says what it is above its name and lists its first three blogs; Discover's,
 * in a tab of blogrolls already, says whose it is and shows its first five blogs as chips (Tela
 * Lists). On a phone a profile's card drops its blogs, to keep three cards on screen (screen 25).
 * Names, descriptions and blog names are shown as written, never translated.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { blogrollHref } from '../lib/blogroll-href'
import { blogAddress, swatchColor } from '../lib/format'
import type { BlogrollCard as BlogrollCardData } from '../views/types'
import { Glyph, LOCK } from './glyph'
import { PersonAvatar } from './person-avatar'
import { Swatch } from './swatch'

/** How many blogs each card shows: a profile's lists three, Discover's chips five. */
const SHOWN = { profile: 3, discover: 5 } as const

type Blog = BlogrollCardData['blogs'][number]
const nameOf = (blog: Blog) => blog.name ?? blogAddress(blog.homeUrl)

export function BlogrollCard({
  card,
  variant,
  isPrivate = false,
  reason = null,
  mine = false,
}: {
  card: BlogrollCardData
  variant: 'profile' | 'discover'
  /** The owner's own card of a blogroll others cannot see. */
  isPrivate?: boolean
  /** Discover's: why the member is shown it, worked out on their device ("You follow Ann"). */
  reason?: string | null
  /** Discover's: the member's own, whose owner's picture is on the accent as everywhere. */
  mine?: boolean
}) {
  const t = useTranslations('profile.blogrolls.card')
  const blogs = card.blogs.slice(0, SHOWN[variant])
  const owner = card.owner.displayName ?? `@${card.owner.handle}`
  return (
    <Link
      to={blogrollHref(card.id)}
      className={`flex w-full min-w-0 animate-fade flex-col gap-2.5 rounded-xl border border-line bg-surface p-4 text-ink transition-colors hover:border-thumb hover:text-ink hover:no-underline md:p-5 ${
        variant === 'profile' ? 'md:min-h-[240px]' : ''
      }`}
      data-testid="blogroll-card"
      data-blogroll-id={card.id}
    >
      {variant === 'discover' ? (
        <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted">
          <PersonAvatar
            handle={card.owner.handle}
            displayName={card.owner.displayName}
            avatar={card.owner.avatar}
            size={22}
            me={mine}
          />
          <span className="min-w-0 truncate font-medium text-ink">{owner}</span>
          {reason ? (
            <>
              <span aria-hidden="true" className="shrink-0">
                ·
              </span>
              <span className="min-w-0 truncate" data-testid="blogroll-reason">
                {reason}
              </span>
            </>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            {t('kind')}
          </span>
          {isPrivate ? (
            <span
              className="flex shrink-0 items-center gap-1 text-[12px] text-muted"
              data-testid="blogroll-private"
            >
              <Glyph size={11} strokeWidth={1.6} className="block">
                {LOCK}
              </Glyph>
              {t('private')}
            </span>
          ) : null}
        </div>
      )}
      <h3 className="m-0 line-clamp-2 font-serif text-[22px] leading-[1.15] font-medium tracking-[-0.01em] [overflow-wrap:anywhere] md:text-[24px]">
        {card.name}
      </h3>
      {card.description ? (
        <p className="m-0 line-clamp-2 font-serif text-[15.5px] leading-[1.4] text-ink-2 [overflow-wrap:anywhere] md:text-[16px]">
          {card.description}
        </p>
      ) : null}
      {variant === 'discover' && blogs.length > 0 ? (
        <ul className="m-0 mt-1 flex list-none flex-wrap gap-1 p-0">
          {blogs.map((blog) => (
            <li key={blog.feedId} title={nameOf(blog)}>
              <Swatch id={blog.feedId} title={nameOf(blog)} size={26} />
              <span className="sr-only">{nameOf(blog)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-auto flex flex-col gap-2.5">
        {variant === 'profile' && blogs.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-[7px] border-t border-line p-0 pt-3.5 max-md:hidden">
            {blogs.map((blog) => (
              <li
                key={blog.feedId}
                className="flex min-w-0 items-center gap-2.5 text-[13px] text-ink-2"
              >
                <span
                  aria-hidden="true"
                  className="size-3.5 shrink-0 rounded-[4px]"
                  style={{ background: swatchColor(blog.feedId) }}
                />
                <span className="min-w-0 truncate">{nameOf(blog)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="text-[12.5px] text-muted">{t('blogs', { n: card.blogCount })}</div>
      </div>
    </Link>
  )
}

/** Cards in a grid as wide as the page allows, one column on a phone. */
export const BLOGROLL_GRID = {
  profile:
    'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(270px,100%),1fr))] gap-3 p-0 md:gap-4',
  discover:
    'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-3 p-0 md:gap-4',
} as const
