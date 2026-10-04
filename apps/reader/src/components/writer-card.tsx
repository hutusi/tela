/**
 * A writer's calling card (For writers): what their profile at `/@handle` will say, drawn as the
 * design draws it, a paper card on either ground (`.paper` in `styles.css`). Three states, and only
 * what Tela has: a real member's live public profile as the example (`lib/example.ts`); the
 * visitor's own card as they type (their name, the handle suggested, their blog), with
 * recommendations and blogs read still to come; or an empty outline when there is neither. Pure,
 * so a test renders it.
 */
import { Fragment } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { displayHost, personColor, swatchColor } from '../lib/format'
import { publicTitle } from '../lib/public-title'
import type { ProfileData, Reading } from '../views/types'
import { PersonAvatar } from './person-avatar'

/** What the visitor has typed: their name, the handle it suggests, and their blog's host. */
export type CardDraft = { name: string; handle: string | null; host: string }

const CARD =
  'paper paper-card flex w-full max-w-[500px] flex-col gap-[18px] rounded-[18px] p-6 text-left text-ink sm:p-8'
const NAME =
  'block truncate font-serif text-[30px] leading-[1.05] font-medium tracking-[-0.015em] sm:text-[34px]'
const LABEL = 'text-[11px] font-semibold tracking-[0.1em] text-muted uppercase'
const STAT = 'font-serif text-[22px] font-medium text-ink'
const CHIP = 'rounded-full border border-line py-1 text-[13px]'
/** The Follow pill, ink on the paper. */
const FOLLOW =
  'shrink-0 rounded-full bg-ink px-4 py-2 text-[13.5px] font-medium text-paper hover:text-paper hover:no-underline'

/** How many blogs read the card names before "+N". */
const READS_SHOWN = 4

/** A site's colour, as its avatar has it when it has no favicon (`SiteAvatar`). */
export const siteColor = (siteId: number) => swatchColor(siteId * 7919)

/** A blog's name from its host, until it has its own: `ada-writes.dev` → "Ada Writes". */
export function blogNameOf(host: string): string {
  const labels = host.split('.')
  const named = labels.length > 1 ? labels.slice(0, -1).join(' ') : host
  return named.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function WriterCard({
  draft,
  example,
  reading,
  own = false,
}: {
  /** The visitor's card, once they have typed anything; it wins over the example. */
  draft: CardDraft | null
  /** The example member's public profile; null while it loads, or when there is none. */
  example: ProfileData | null
  reading: Reading
  /** The example is the viewer's own card, which offers them no Follow. */
  own?: boolean
}) {
  if (draft) return <DraftCard draft={draft} />
  if (example) return <ExampleCard data={example} reading={reading} own={own} />
  return <OutlineCard />
}

function ExampleCard({
  data,
  reading,
  own,
}: {
  data: ProfileData
  reading: Reading
  own: boolean
}) {
  const t = useTranslations('writers.card')
  const { profile, counts } = data
  const name = profile.displayName ?? `@${profile.handle}`
  const card = `/@${profile.handle}`
  const latest = data.recommendations[0]
  const shown = latest ? publicTitle(latest.article, reading) : null
  // Whom they read, only when they show it.
  const reads = data.subscriptions !== null && counts?.subscriptions != null
  const readList = data.subscriptions ?? []
  const more = Math.max(0, (counts?.subscriptions ?? readList.length) - READS_SHOWN)
  const stat = (chunks: React.ReactNode) => <b className={STAT}>{chunks}</b>
  return (
    <article className={CARD} data-testid="writer-card" data-card="example">
      <header className="flex items-center gap-4">
        <PersonAvatar
          handle={profile.handle}
          displayName={profile.displayName}
          avatar={profile.avatar}
          size={60}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Link
            to={card}
            className={`${NAME} text-ink hover:text-ink hover:no-underline`}
            data-testid="writer-card-name"
          >
            {name}
          </Link>
          <span className="text-[13.5px] text-muted" data-testid="writer-card-handle">
            {`@${profile.handle}`}
          </span>
        </div>
        {own ? null : (
          <Link to={card} className={FOLLOW} data-testid="writer-card-follow">
            {t('follow')}
          </Link>
        )}
      </header>
      {data.blogs.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[14px] text-ink-2"
          data-testid="writer-card-blogs"
        >
          <span>{t('writes')}</span>
          {data.blogs.map((site) => (
            <Fragment key={site.id}>
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-[3px]"
                style={{ background: siteColor(site.id) }}
              />
              <b className="font-medium text-ink">{site.title ?? displayHost(site.homeUrl)}</b>
              <span className="text-muted">{displayHost(site.homeUrl)}</span>
            </Fragment>
          ))}
          <span className="text-[12.5px] font-semibold text-accent">✓ {t('claimed')}</span>
        </div>
      ) : null}
      {profile.bio ? (
        <p
          className="m-0 font-serif text-[19px] leading-[1.4] text-pretty text-body italic"
          data-testid="writer-card-bio"
        >
          {profile.bio}
        </p>
      ) : null}
      {counts ? (
        <div
          className="flex flex-wrap items-baseline gap-x-[22px] gap-y-1 text-[13px] text-muted"
          data-testid="writer-card-counts"
        >
          {(['followers', 'recommendations'] as const).map((k) => (
            <span key={k} className="whitespace-nowrap">
              {t.rich(k, { n: counts[k], b: stat })}
            </span>
          ))}
          {reads ? (
            <span className="whitespace-nowrap" data-testid="writer-card-reads">
              {t.rich('reads', { n: counts.subscriptions ?? 0, b: stat })}
            </span>
          ) : null}
        </div>
      ) : null}
      {latest && shown ? (
        <>
          <div className="h-px bg-line" />
          <div className="flex flex-col gap-1.5" data-testid="writer-card-latest">
            <span className={LABEL}>{t('recommends')}</span>
            <span className="font-serif text-[22px] leading-[1.2] font-medium text-ink">
              {shown.title}
            </span>
            {latest.note ? (
              <p className="m-0 font-serif text-[16.5px] leading-[1.4] text-ink-2 italic">
                “{latest.note}”
              </p>
            ) : null}
          </div>
        </>
      ) : null}
      {reads && readList.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="writer-card-reads-list">
          <span className={LABEL}>{t('readsLabel')}</span>
          <div className="flex flex-wrap gap-1.5">
            {readList.slice(0, READS_SHOWN).map((site) => (
              <span
                key={site.id}
                className={`${CHIP} flex min-w-0 items-center gap-1.5 pr-[11px] pl-2 text-ink`}
              >
                <span
                  aria-hidden="true"
                  className="size-[9px] shrink-0 rounded-[2px]"
                  style={{ background: siteColor(site.id) }}
                />
                <span className="truncate">{site.title ?? displayHost(site.homeUrl)}</span>
              </span>
            ))}
            {more > 0 ? <span className={`${CHIP} px-[11px] text-muted`}>+{more}</span> : null}
          </div>
        </div>
      ) : null}
    </article>
  )
}

function DraftCard({ draft }: { draft: CardDraft }) {
  const t = useTranslations('writers.card')
  const name = draft.name.trim()
  const blog = draft.host ? blogNameOf(draft.host) : ''
  const zero = (chunks: React.ReactNode) => <b className={STAT}>{chunks}</b>
  return (
    <article className={CARD} data-testid="writer-card" data-card="draft">
      <header className="flex items-center gap-4">
        <PersonAvatar
          handle={draft.handle ?? (name || draft.host || '?')}
          displayName={name || blog || null}
          size={60}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className={`${NAME} ${name ? 'text-ink' : 'text-muted/60'}`}
            data-testid="writer-card-name"
          >
            {name || t('yourName')}
          </span>
          <span className="text-[13.5px] text-muted" data-testid="writer-card-handle">
            {`@${draft.handle ?? t('yourHandle')}`}
          </span>
        </div>
        <span aria-hidden="true" className={FOLLOW}>
          {t('follow')}
        </span>
      </header>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[14px] text-ink-2">
        <span>{t('writes')}</span>
        <span
          aria-hidden="true"
          className="size-3 shrink-0 rounded-[3px] bg-thumb"
          style={draft.host ? { background: personColor(draft.host) } : undefined}
        />
        <b className="font-medium text-ink">{blog || t('yourBlog')}</b>
        {draft.host ? (
          <span className="min-w-0 truncate text-muted" data-testid="writer-card-blog">
            {draft.host}
          </span>
        ) : null}
      </div>
      <p className="m-0 font-serif text-[19px] leading-[1.4] text-body italic">{t('bioLater')}</p>
      <div className="flex flex-wrap items-baseline gap-x-[22px] gap-y-1 text-[13px] text-muted">
        {(['followers', 'recommendations'] as const).map((k) => (
          <span key={k} className="whitespace-nowrap">
            {t.rich(k, { n: 0, b: zero })}
          </span>
        ))}
      </div>
      <div className="h-px bg-line" />
      <div className="flex flex-col gap-1.5">
        <span className={LABEL}>{t('recommends')}</span>
        <span className="font-serif text-[22px] leading-[1.2] font-medium text-muted">
          {t('latestLater')}
        </span>
      </div>
      <p
        className="m-0 rounded-xl border border-dashed border-thumb p-4 text-[13.5px] leading-normal text-muted"
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
    <div className={CARD} aria-hidden="true" data-testid="writer-card-outline" data-card="outline">
      <div className="flex items-center gap-4">
        <span className="size-[60px] shrink-0 rounded-full bg-hover" />
        <div className="flex flex-1 flex-col gap-2">
          <span className={`${bar} h-7 w-2/3`} />
          <span className={`${bar} h-3 w-1/3`} />
        </div>
      </div>
      <span className={`${bar} h-3 w-1/2`} />
      <span className={`${bar} h-4 w-full`} />
      <span className={`${bar} h-4 w-5/6`} />
      <span className="h-px bg-line" />
      <span className={`${bar} h-3 w-1/4`} />
      <span className={`${bar} h-5 w-4/5`} />
    </div>
  )
}
