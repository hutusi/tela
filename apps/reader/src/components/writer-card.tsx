/**
 * A writer's calling card (For writers): what their profile at `/@handle` will say, drawn small.
 * Three states, and only what Tela has: a real member's live public profile as the example
 * (`lib/example.ts`); the visitor's own card as they type (their name, the handle suggested, their
 * blog), with recommendations and blogs read still to come; or an empty outline when there is
 * neither. Pure, so a test renders it.
 */
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { displayHost, swatchColor } from '../lib/format'
import { publicTitle } from '../lib/public-title'
import type { ProfileData, Reading } from '../views/types'
import { PersonAvatar } from './person-avatar'
import { SiteAvatar } from './site-avatar'

/** What the visitor has typed: their name, the handle it suggests, and their blog's host. */
export type CardDraft = { name: string; handle: string | null; host: string }

const CARD =
  'flex w-full flex-col gap-4 rounded-2xl border border-line bg-surface p-6 text-left shadow-[0_18px_48px_rgba(0,0,0,.08)] sm:p-7'

export function WriterCard({
  draft,
  example,
  reading,
}: {
  /** The visitor's card, once they have typed anything; it wins over the example. */
  draft: CardDraft | null
  /** The example member's public profile; null while it loads, or when there is none. */
  example: ProfileData | null
  reading: Reading
}) {
  if (draft) return <DraftCard draft={draft} />
  if (example) return <ExampleCard data={example} reading={reading} />
  return <OutlineCard />
}

function ExampleCard({ data, reading }: { data: ProfileData; reading: Reading }) {
  const t = useTranslations('writers.card')
  const { profile, counts } = data
  const name = profile.displayName ?? `@${profile.handle}`
  const latest = data.recommendations[0]
  // Whom they read, only when they show it.
  const reads = data.subscriptions !== null && counts?.subscriptions != null
  return (
    <article className={CARD} data-testid="writer-card" data-card="example">
      <header className="flex items-center gap-4">
        <PersonAvatar
          handle={profile.handle}
          displayName={profile.displayName}
          avatar={profile.avatar}
          size={56}
        />
        <div className="min-w-0">
          <Link
            to={`/@${profile.handle}`}
            className="block truncate font-serif text-[26px] leading-[1.1] font-medium tracking-[-0.01em] text-ink hover:no-underline"
            data-testid="writer-card-name"
          >
            {name}
          </Link>
          <div className="mt-1 text-[13px] text-muted" data-testid="writer-card-handle">
            {`@${profile.handle}`}
          </div>
        </div>
      </header>
      {data.blogs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-ink-2">
          <span>{t('writes')}</span>
          {data.blogs.map((site) => (
            <span key={site.id} className="flex items-center gap-1.5 font-medium text-ink">
              <SiteAvatar
                id={site.id}
                title={site.title ?? site.homeUrl}
                faviconKey={site.faviconKey}
                size={18}
                radius={5}
              />
              {site.title ?? displayHost(site.homeUrl)}
            </span>
          ))}
        </div>
      ) : null}
      {profile.bio ? (
        <p
          className="m-0 font-serif text-[17px] leading-[1.45] text-body"
          style={{ textWrap: 'pretty' }}
          data-testid="writer-card-bio"
        >
          {profile.bio}
        </p>
      ) : null}
      {counts ? (
        <div
          className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2"
          data-testid="writer-card-counts"
        >
          {(['followers', 'recommendations'] as const).map((k) => (
            <span key={k}>
              {t.rich(k, {
                n: counts[k],
                b: (chunks) => <b className="font-semibold text-ink">{chunks}</b>,
              })}
            </span>
          ))}
          {reads ? (
            <span data-testid="writer-card-reads">
              {t.rich('reads', {
                n: counts.subscriptions ?? 0,
                b: (chunks) => <b className="font-semibold text-ink">{chunks}</b>,
              })}
            </span>
          ) : null}
        </div>
      ) : null}
      {latest ? (
        <div
          className="flex flex-col gap-2 border-t border-line pt-4"
          data-testid="writer-card-latest"
        >
          <div className="text-[11.5px] font-medium tracking-[0.06em] text-muted uppercase">
            {t('recommends')}
          </div>
          {latest.note ? (
            <p className="m-0 font-serif text-[16.5px] leading-[1.4] italic">“{latest.note}”</p>
          ) : null}
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ background: swatchColor(latest.article.feedId) }}
            />
            <span className="truncate font-medium text-ink">
              {latest.siteTitle ?? displayHost(latest.homeUrl)}
            </span>
          </div>
          <div className="font-serif text-[18px] leading-[1.25] font-medium">
            {publicTitle(latest.article, reading).title}
          </div>
        </div>
      ) : null}
    </article>
  )
}

function DraftCard({ draft }: { draft: CardDraft }) {
  const t = useTranslations('writers.card')
  const name = draft.name.trim()
  return (
    <article className={CARD} data-testid="writer-card" data-card="draft">
      <header className="flex items-center gap-4">
        <PersonAvatar handle={draft.handle ?? (name || '?')} displayName={name || null} size={56} />
        <div className="min-w-0">
          <div
            className={`truncate font-serif text-[26px] leading-[1.1] font-medium tracking-[-0.01em] ${name ? 'text-ink' : 'text-muted'}`}
            data-testid="writer-card-name"
          >
            {name || t('yourName')}
          </div>
          <div className="mt-1 text-[13px] text-muted" data-testid="writer-card-handle">
            {`@${draft.handle ?? t('yourHandle')}`}
          </div>
        </div>
      </header>
      {draft.host ? (
        <div className="flex items-center gap-2.5 text-[13px] text-ink-2">
          <span>{t('writes')}</span>
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-ink">
            <span aria-hidden="true" className="size-[18px] shrink-0 rounded-[5px] bg-thumb" />
            <span className="truncate" data-testid="writer-card-blog">
              {draft.host}
            </span>
          </span>
        </div>
      ) : null}
      <p
        className="m-0 rounded-xl border border-dashed border-thumb px-4 py-3.5 text-[13px] leading-normal text-muted"
        data-testid="writer-card-later"
      >
        {t('later')}
      </p>
    </article>
  )
}

/** Room for a card, and nothing in it: no example to show, and nothing typed yet. */
function OutlineCard() {
  const bar = 'block rounded bg-hover'
  return (
    <div
      className={`${CARD} border-dashed`}
      aria-hidden="true"
      data-testid="writer-card-outline"
      data-card="outline"
    >
      <div className="flex items-center gap-4">
        <span className="size-14 shrink-0 rounded-full bg-hover" />
        <div className="flex flex-1 flex-col gap-2">
          <span className={`${bar} h-5 w-2/3`} />
          <span className={`${bar} h-3 w-1/3`} />
        </div>
      </div>
      <span className={`${bar} h-3 w-1/2`} />
      <span className={`${bar} h-4 w-full`} />
      <span className={`${bar} h-4 w-5/6`} />
      <span className={`${bar} h-3 w-2/5`} />
    </div>
  )
}
