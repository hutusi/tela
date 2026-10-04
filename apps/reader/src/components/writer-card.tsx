/**
 * A writer's calling card (For writers): what their profile at `/@handle` will say, drawn as the
 * design draws it, a paper card on either ground (`.paper` in `styles.css`). Two states, and only
 * what Tela has: a sample, labelled as one beside it (`lib/sample-card.ts`, ADR 0037), until the
 * visitor types; then their own card as they type (their name, the handle suggested, their blog),
 * with recommendations and blogs read still to come. Neither is anyone's yet, so nothing on either
 * links anywhere. Pure, so a test renders it.
 */
import { useTranslations } from 'use-intl'
import { personColor } from '../lib/format'
import type { Sample } from '../lib/sample-card'
import { PersonAvatar } from './person-avatar'

/** What the visitor has typed: their name, the handle it suggests, and their blog's host. */
export type CardDraft = { name: string; handle: string | null; host: string }

const CARD =
  'paper paper-card flex w-full max-w-[500px] flex-col gap-[18px] rounded-[18px] p-6 text-left text-ink sm:p-8'
const NAME =
  'block truncate font-serif text-[30px] leading-[1.05] font-medium tracking-[-0.015em] sm:text-[34px]'
/**
 * The @handle under the name. A handle may be thirty characters with nowhere to break, so it is
 * cut with an ellipsis inside its column, as the name is, and never runs under the Follow pill.
 */
const HANDLE = 'block truncate text-[13.5px] text-muted'
const LABEL = 'text-[11px] font-semibold tracking-[0.1em] text-muted uppercase'
const STAT = 'font-serif text-[22px] font-medium text-ink'
const CHIP = 'rounded-full border border-line py-1 text-[13px]'
/** The Follow pill, ink on the paper: drawn, not a control, on a card that is no one's yet. */
const FOLLOW = 'shrink-0 rounded-full bg-ink px-4 py-2 text-[13.5px] font-medium text-paper'

/** A blog's name from its host, until it has its own: `ada-writes.dev` → "Ada Writes". */
export function blogNameOf(host: string): string {
  const labels = host.split('.')
  const named = labels.length > 1 ? labels.slice(0, -1).join(' ') : host
  return named.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function WriterCard({
  draft,
  sample,
}: {
  /** The visitor's card, once they have typed anything; it wins over the sample. */
  draft: CardDraft | null
  sample: Sample
}) {
  return draft ? <DraftCard draft={draft} /> : <SampleCard sample={sample} />
}

/** A swatch in a blog's colour, as the design marks each blog. */
function Dot({ color, size, radius }: { color: string; size: number; radius: number }) {
  return (
    <span
      aria-hidden="true"
      className="shrink-0"
      style={{ background: color, width: size, height: size, borderRadius: radius }}
    />
  )
}

function SampleCard({ sample }: { sample: Sample }) {
  const t = useTranslations('writers')
  const { writer, counts } = sample
  const more = Math.max(0, counts.reads - sample.reads.length)
  const stat = (chunks: React.ReactNode) => <b className={STAT}>{chunks}</b>
  return (
    <article className={CARD} data-testid="writer-card" data-card="sample">
      <header className="flex items-center gap-4">
        <PersonAvatar handle={writer.handle} displayName={writer.name} size={60} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={NAME} data-testid="writer-card-name">
            {writer.name}
          </span>
          <span className={HANDLE} title={`@${writer.handle}`} data-testid="writer-card-handle">
            {`@${writer.handle}`}
          </span>
        </div>
        <span aria-hidden="true" className={FOLLOW} data-testid="writer-card-follow">
          {t('card.follow')}
        </span>
      </header>
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[14px] text-ink-2"
        data-testid="writer-card-blogs"
      >
        <span>{t('card.writes')}</span>
        <Dot color={sample.blog.color} size={12} radius={3} />
        <b className="font-medium text-ink">{sample.blog.name}</b>
        <span className="text-muted">{sample.host}</span>
        <span className="text-[12.5px] font-semibold text-accent">✓ {t('card.claimed')}</span>
      </div>
      <p
        className="m-0 font-serif text-[19px] leading-[1.4] text-pretty text-body italic"
        data-testid="writer-card-bio"
      >
        {sample.bio}
      </p>
      <div
        className="flex flex-wrap items-baseline gap-x-[22px] gap-y-1 text-[13px] text-muted"
        data-testid="writer-card-counts"
      >
        {(['followers', 'recommendations'] as const).map((k) => (
          <span key={k} className="whitespace-nowrap">
            {t.rich(`card.${k}`, { n: counts[k], b: stat })}
          </span>
        ))}
        <span className="whitespace-nowrap" data-testid="writer-card-reads">
          {t.rich('card.reads', { n: counts.reads, b: stat })}
        </span>
      </div>
      <div className="h-px bg-line" />
      <div className="flex flex-col gap-1.5" data-testid="writer-card-latest">
        <span className={LABEL}>{t('card.recommends')}</span>
        <span className="font-serif text-[22px] leading-[1.2] font-medium text-ink">
          {t(`sample.posts.${sample.latest.post}`)}
        </span>
        <p className="m-0 font-serif text-[16.5px] leading-[1.4] text-ink-2 italic">
          “{sample.latest.note}”
        </p>
      </div>
      <div className="flex flex-col gap-2" data-testid="writer-card-reads-list">
        <span className={LABEL}>{t('card.readsLabel')}</span>
        <div className="flex flex-wrap gap-1.5">
          {sample.reads.map((blog) => (
            <span
              key={blog.name}
              className={`${CHIP} flex min-w-0 items-center gap-1.5 pr-[11px] pl-2 text-ink`}
            >
              <Dot color={blog.color} size={9} radius={2} />
              <span className="truncate">{blog.name}</span>
            </span>
          ))}
          {more > 0 ? <span className={`${CHIP} px-[11px] text-muted`}>{`+${more}`}</span> : null}
        </div>
      </div>
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
          <span
            className={HANDLE}
            title={`@${draft.handle ?? t('yourHandle')}`}
            data-testid="writer-card-handle"
          >
            {`@${draft.handle ?? t('yourHandle')}`}
          </span>
        </div>
        <span aria-hidden="true" className={FOLLOW} data-testid="writer-card-follow">
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
