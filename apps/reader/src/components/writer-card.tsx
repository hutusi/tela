/**
 * A writer's calling card (For writers): what their profile at `/@handle` will say, drawn as Tela
 * Public draws it (ADR 0070), a card on the page's own ground in either theme. Two states, and only
 * what Tela has: a sample, labelled as one above it (`lib/sample-card.ts`, ADR 0037), until the
 * visitor types; then their own card as they type (their name, the handle suggested, their blog),
 * with recommendations and blogs read still to come. Neither is anyone's yet, so nothing on either
 * links anywhere. Pure, so a test renders it.
 */
import { useTranslations } from 'use-intl'
import type { Sample } from '../lib/sample-card'
import { PersonAvatar } from './person-avatar'

/** What the visitor has typed: their name, the handle it suggests, and their blog's host. */
export type CardDraft = { name: string; handle: string | null; host: string }

const CARD =
  'flex w-full flex-col gap-3.5 rounded-[14px] border border-line bg-surface p-[clamp(20px,2.6vw,28px)] text-left text-ink'
/**
 * The name: up to two lines beside the Follow pill, breaking anywhere a long word must, then cut.
 * At 360px one line holds some 110px, which cut "Lucía Ferrer" to "Lucía F…".
 */
const NAME =
  'line-clamp-2 font-serif leading-(--lh-h) [overflow-wrap:anywhere] [font-size:calc(28px*var(--ts))] [font-weight:var(--hw)]'
/**
 * The @handle under the name. A handle may be thirty characters with nowhere to break, so it is
 * cut with an ellipsis inside its column, as the name is, and never runs under the Follow pill.
 */
const HANDLE = 'block truncate text-[13.5px] text-muted'
/** A small label over a part of the card, in sentence case. */
const LABEL = 'text-[13px] text-muted'
/** A count inside its line: ink, not a figure set apart. */
const COUNT = 'font-medium text-ink'
/** The Follow pill, outlined: drawn, not a control, on a card that is no one's yet. */
const FOLLOW =
  'flex h-[34px] shrink-0 items-center rounded-full border border-thumb px-[15px] text-[13.5px] font-medium text-ink'
/** Facts joined into one line, each kept whole with the dot before it. */
const dotted = (parts: React.ReactNode[]) =>
  parts.map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, in a fixed order
    <span key={i} className={i ? 'whitespace-nowrap' : undefined}>
      {i ? '· ' : null}
      {part}
      {i < parts.length - 1 ? ' ' : null}
    </span>
  ))

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

function SampleCard({ sample }: { sample: Sample }) {
  const t = useTranslations('writers')
  const tc = useTranslations('common')
  const { writer, counts } = sample
  const more = Math.max(0, counts.reads - sample.reads.length)
  const count = (chunks: React.ReactNode) => <b className={COUNT}>{chunks}</b>
  return (
    <article className={CARD} data-testid="writer-card" data-card="sample">
      <header className="flex items-center gap-3.5">
        <PersonAvatar handle={writer.handle} displayName={writer.name} size={52} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
        className="text-[14px] leading-normal text-ink-2 [overflow-wrap:anywhere]"
        data-testid="writer-card-blogs"
      >
        {t('card.writes')} <b className="font-medium text-ink">{sample.blog.name}</b>{' '}
        <span className="whitespace-nowrap text-muted">·&nbsp;{sample.host}</span>{' '}
        <span className="whitespace-nowrap text-muted">·&nbsp;{t('card.claimed')}</span>
      </div>
      <p
        className="m-0 font-serif leading-(--lh-h) text-pretty text-body [font-size:calc(19px*var(--ts))]"
        data-testid="writer-card-bio"
      >
        {sample.bio}
      </p>
      <div className="text-[13.5px] leading-normal text-muted" data-testid="writer-card-counts">
        {dotted([
          t.rich('card.followers', { n: counts.followers, b: count }),
          t.rich('card.recommendations', { n: counts.recommendations, b: count }),
          <span key="reads" data-testid="writer-card-reads">
            {t.rich('card.reads', { n: counts.reads, b: count })}
          </span>,
        ])}
      </div>
      <div
        className="flex flex-col gap-1 border-t border-line-soft pt-3.5"
        data-testid="writer-card-latest"
      >
        <span className={LABEL}>{t('card.recommends')}</span>
        <span className="font-serif leading-(--lh-h) text-ink [font-size:calc(20px*var(--ts))] [font-weight:var(--hw)]">
          {t(`sample.posts.${sample.latest.post}`)}
        </span>
        <p className="m-0 font-serif leading-(--lh-h) text-ink-2 [font-size:calc(16.5px*var(--ts))]">
          {tc('quoted', { text: sample.latest.note })}
        </p>
      </div>
      <div className="flex flex-col gap-1" data-testid="writer-card-reads-list">
        <span className={LABEL}>{t('card.readsLabel')}</span>
        <div className="flex flex-wrap gap-x-[9px] gap-y-0.5 font-serif text-[16px] leading-normal text-ink-2">
          {sample.reads.map((blog, i) => (
            <span key={blog.name} className="flex gap-x-[9px]">
              {i ? (
                <span aria-hidden="true" className="text-muted">
                  ·
                </span>
              ) : null}
              <span className="[overflow-wrap:anywhere]">{blog.name}</span>
            </span>
          ))}
          {more > 0 ? <span className="text-muted">{`+${more}`}</span> : null}
        </div>
      </div>
    </article>
  )
}

function DraftCard({ draft }: { draft: CardDraft }) {
  const t = useTranslations('writers.card')
  const name = draft.name.trim()
  const blog = draft.host ? blogNameOf(draft.host) : ''
  const zero = (chunks: React.ReactNode) => <b className={COUNT}>{chunks}</b>
  return (
    <article className={CARD} data-testid="writer-card" data-card="draft">
      <header className="flex items-center gap-3.5">
        <PersonAvatar
          handle={draft.handle ?? (name || draft.host || '?')}
          displayName={name || blog || null}
          size={52}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={`${NAME} ${name ? 'text-ink' : 'text-muted'}`}
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
      <div className="text-[14px] leading-normal text-ink-2 [overflow-wrap:anywhere]">
        {t('writes')} <b className="font-medium text-ink">{blog || t('yourBlog')}</b>
        {draft.host ? (
          <>
            {' '}
            {/* A host can be long with nowhere to break: it may break anywhere, the dot kept with it. */}
            <span className="text-muted">
              ·&nbsp;<span data-testid="writer-card-blog">{draft.host}</span>
            </span>
          </>
        ) : null}
      </div>
      <p className="m-0 font-serif leading-(--lh-h) text-muted [font-size:calc(19px*var(--ts))]">
        {t('bioLater')}
      </p>
      <div className="text-[13.5px] leading-normal text-muted">
        {dotted([
          t.rich('followers', { n: 0, b: zero }),
          t.rich('recommendations', { n: 0, b: zero }),
        ])}
      </div>
      <div className="flex flex-col gap-1 border-t border-line-soft pt-3.5">
        <span className={LABEL}>{t('recommends')}</span>
        <span className="font-serif leading-(--lh-h) text-muted [font-size:calc(20px*var(--ts))] [font-weight:var(--hw)]">
          {t('latestLater')}
        </span>
      </div>
      <p className="m-0 text-[13.5px] leading-normal text-muted" data-testid="writer-card-later">
        {t('later')}
      </p>
    </article>
  )
}
