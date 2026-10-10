/**
 * Discover's This week (`/discover`, ADR 0044): the week's most recommended posts, else the
 * newest from the directory; blogs new to it; and readers to follow. Pure, rendered by the SPA and
 * the edge: the page composes the week (`composeWeek`) and the readers (`suggestReaders`) with
 * what its member already reads and follows, the edge with nothing hidden, for a visitor.
 */
import { useTranslations } from 'use-intl'
import { SectionHead } from '../components/discover-filters'
import { LeadPost, RankedPost } from '../components/discover-post'
import { ReaderCard } from '../components/reader-card'
import { SiteCard } from '../components/site-card'
import { tabHref } from '../lib/discover-href'
import type { ComposedWeek } from '../lib/discover-week'
import type { Suggestion } from '../lib/suggest-readers'
import { DiscoverFrame } from './discover-frame'
import type { DiscoverPost, MemberControls, Person, Reading } from './types'

/** This week shows three readers to follow; the Readers tab shows them all. */
export const WEEK_READERS = 3

const HERE = tabHref('week')
const NOBODY: readonly Person[] = []
const nobody = () => NOBODY

export function DiscoverWeekView({
  week,
  readers,
  member,
  reading,
  locale,
  now,
  followed = nobody,
}: {
  /** Null while the week is on its way. */
  week: ComposedWeek | null
  /** The readers to suggest, at most three. */
  readers: readonly Suggestion[]
  member?: MemberControls | undefined
  reading: Reading
  locale: string
  now: number
  /** Whom the member follows among a post's recommenders. */
  followed?: (post: DiscoverPost) => readonly Person[]
}) {
  const t = useTranslations('discover')
  if (week === null) {
    return (
      <DiscoverFrame tab="week">
        <div
          className="h-[340px] animate-pulse rounded-[14px] border border-line bg-surface"
          aria-busy="true"
        />
      </DiscoverFrame>
    )
  }
  const shared = { member, reading, locale, now }
  return (
    <DiscoverFrame tab="week">
      <SectionHead
        first
        label={t(`week.span.${week.span}`)}
        link={{ to: tabHref('articles'), text: t('week.allArticles') }}
        testId="week-span"
        span={week.span}
      />
      {week.lead ? (
        <>
          <LeadPost post={week.lead} followed={followed(week.lead)} next={HERE} {...shared} />
          {week.rest.length > 0 ? (
            <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(min(100%,420px),1fr))] gap-x-12">
              {week.rest.map((post, i) => (
                <RankedPost
                  key={post.article.id}
                  post={post}
                  rank={i + 2}
                  followed={followed(post)}
                  {...shared}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p
          className="m-0 rounded-[14px] border border-line px-6 py-14 text-center text-muted"
          data-testid="week-empty"
        >
          {t('week.empty')}
        </p>
      )}

      {week.newBlogs.length > 0 ? (
        <>
          <SectionHead
            label={t('week.newBlogs')}
            link={{ to: tabHref('blogs'), text: t('week.allBlogs') }}
          />
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4"
            data-testid="week-new-blogs"
          >
            {week.newBlogs.map((site) => (
              <SiteCard
                key={site.id}
                site={site}
                member={member}
                next={HERE}
                label={t('week.newLabel')}
              />
            ))}
          </div>
        </>
      ) : null}

      {readers.length > 0 ? (
        <>
          <SectionHead
            label={t('week.readersToFollow')}
            link={{ to: tabHref('readers'), text: t('week.allReaders') }}
          />
          <div
            className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4"
            data-testid="week-readers"
          >
            {readers.map((s) => (
              <ReaderCard
                key={s.person.id}
                suggestion={s}
                variant="card"
                member={member}
                reading={reading}
                next={HERE}
              />
            ))}
          </div>
        </>
      ) : null}

      {week.lead ? (
        <p className="m-0 mt-14 max-w-[640px] border-t border-line pt-6 text-[13px] leading-normal text-muted">
          {week.span === 'recommended' ? t('week.footer.recommended') : t('week.footer.edition')}
        </p>
      ) : null}
    </DiscoverFrame>
  )
}
