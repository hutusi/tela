/**
 * Discover's Readers (`/discover/readers`, ADR 0044): readers to follow, grouped by why. Pure,
 * rendered by the SPA and the edge; the page matches the pool against its member's own likes,
 * recommendations and blogs (`suggestReaders`), and the edge, for a visitor, against nothing.
 */
import { useTranslations } from 'use-intl'
import { ReaderCard } from '../components/reader-card'
import { tabHref } from '../lib/discover-href'
import { READER_GROUPS, type Suggestion } from '../lib/suggest-readers'
import { DiscoverFrame } from './discover-frame'
import type { MemberControls, Reading } from './types'

const HERE = tabHref('readers')

export function DiscoverReadersView({
  suggestions,
  member,
  reading,
}: {
  /** Null while the pool is on its way. */
  suggestions: readonly Suggestion[] | null
  member?: MemberControls | undefined
  reading: Reading
}) {
  const t = useTranslations('discover.people')
  const groups = READER_GROUPS.map((group) => ({
    group,
    people: (suggestions ?? []).filter((s) => s.group === group),
  })).filter((g) => g.people.length > 0)
  return (
    <DiscoverFrame tab="readers">
      <p className="m-0 max-w-[620px] text-[13px] leading-normal text-muted">{t('intro')}</p>
      {suggestions === null ? (
        <div className="mt-10" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-b border-line py-6">
              <div className="h-[72px] max-w-[660px] animate-pulse rounded-lg bg-hover" />
            </div>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <p className="m-0 py-14 text-center text-muted" data-testid="readers-empty">
          {t('empty')}
        </p>
      ) : (
        groups.map(({ group, people }) => (
          <section key={group} className="mt-10" data-testid="reader-group" data-group={group}>
            <h2 className="m-0 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              {t(`groups.${group}`)}
            </h2>
            {people.map((s) => (
              <ReaderCard
                key={s.person.id}
                suggestion={s}
                variant="row"
                member={member}
                reading={reading}
                next={HERE}
              />
            ))}
          </section>
        ))
      )}
    </DiscoverFrame>
  )
}
