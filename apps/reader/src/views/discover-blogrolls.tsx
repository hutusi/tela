/**
 * Discover's Blogrolls (`/discover/blogrolls`, ADR 0050): public blogrolls with three or more blogs
 * others see, the newest public first. Pure, rendered by the SPA and the edge. Why the member is
 * shown one ("You follow Ann", "Yours") is worked out on their device and comes in by `reasonOf`;
 * a visitor gets none. "More" is a link to the next page, which the app turns into more of this one.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { BLOGROLL_GRID, BlogrollCard } from '../components/blogroll-card'
import { blogrollsHref } from '../lib/blogroll-href'
import { DiscoverFrame } from './discover-frame'
import type { BlogrollCard as BlogrollCardData } from './types'

/** Why a blogroll is on the member's Discover: theirs, or by someone they follow. */
export type BlogrollReason = 'yours' | 'follows' | null

const noReason = (): BlogrollReason => null

export function DiscoverBlogrollsView({
  cards,
  next,
  reasonOf = noReason,
  onMore,
  loadingMore = false,
}: {
  /** Null while the first page is on its way. */
  cards: readonly BlogrollCardData[] | null
  /** The cursor of the page after these, if there is one. */
  next: string | null
  reasonOf?: (card: BlogrollCardData) => BlogrollReason
  /** More of this page in place, once the app runs: the link's own click, to prevent. */
  onMore?: ((event: React.MouseEvent<HTMLAnchorElement>) => void) | undefined
  loadingMore?: boolean
}) {
  const t = useTranslations('discover.blogrolls')
  return (
    <DiscoverFrame tab="blogrolls">
      <p className="m-0 mb-6 max-w-[620px] text-[14px] leading-normal text-muted md:-mt-3 md:mb-7">
        {t('intro')}
      </p>
      {cards === null ? (
        <div className={BLOGROLL_GRID.discover} aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[190px] animate-pulse rounded-xl bg-hover" />
          ))}
        </div>
      ) : cards.length === 0 && next === null ? (
        <p className="m-0 py-14 text-center text-muted" data-testid="blogrolls-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className={BLOGROLL_GRID.discover} data-testid="blogrolls-list">
          {cards.map((card) => {
            const reason = reasonOf(card)
            const name = card.owner.displayName ?? `@${card.owner.handle}`
            return (
              <li key={card.id} className="flex min-w-0">
                <BlogrollCard
                  card={card}
                  variant="discover"
                  reason={
                    reason === 'yours'
                      ? t('reasons.yours')
                      : reason === 'follows'
                        ? t('reasons.follows', { name })
                        : null
                  }
                  mine={reason === 'yours'}
                />
              </li>
            )
          })}
        </ul>
      )}

      {cards !== null && next !== null ? (
        <div className="pt-8 text-center">
          <Link
            to={blogrollsHref(next)}
            onClick={onMore}
            aria-disabled={loadingMore || undefined}
            className={`inline-block rounded-full border border-thumb px-4 py-2 text-[13px] font-medium text-ink hover:border-ink hover:text-ink hover:no-underline ${
              loadingMore ? 'opacity-60' : ''
            }`}
            data-testid="blogrolls-more"
          >
            {t('more')}
          </Link>
        </div>
      ) : null}
    </DiscoverFrame>
  )
}
