/**
 * The pieces every area's record is made of, as the design draws them (Tela Admin, 2a): a status
 * dot, key and value rows, a labelled section, an evidence block, a dashed note, and the history an
 * operator left. Areas compose these; the shell owns the panel around them.
 */
import type { AdminHistoryEntry, AdminTone } from '@tela/shared/admin'
import { useLocale, useTranslations } from 'use-intl'
import { relativeTime } from '../../lib/format'

const TONE: Record<AdminTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-muted',
}

export function Dot({ tone }: { tone: AdminTone }) {
  return <span aria-hidden="true" className={`size-[7px] shrink-0 rounded-full ${TONE[tone]}`} />
}

/** A state in a pill: its dot and its words. */
export function StatusPill({ tone, label }: { tone: AdminTone; label: string }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-full border border-thumb py-0.5 pr-[9px] pl-[7px] text-[12px] font-medium whitespace-nowrap text-ink-2"
      data-tone={tone}
    >
      <Dot tone={tone} />
      <span className="truncate">{label}</span>
    </span>
  )
}

/** Rows of a label and its value, ruled between. A null value leaves its row out. */
export function KeyValues({ rows }: { rows: readonly (readonly [string, React.ReactNode])[] }) {
  return (
    <dl className="flex flex-col border-t border-line">
      {rows
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[minmax(96px,140px)_minmax(0,1fr)] gap-4 border-b border-line py-[9px] text-[13.5px]"
          >
            <dt className="text-muted">{label}</dt>
            <dd className="m-0 [overflow-wrap:anywhere] whitespace-pre-line text-ink">{value}</dd>
          </div>
        ))}
    </dl>
  )
}

/** A small uppercase label over a part of the record. */
export function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="m-0 text-[11px] font-semibold tracking-[.08em] text-muted uppercase">
        {label}
      </h3>
      {children}
    </section>
  )
}

/** What the work saw, as it saw it: an error, a request and its answer, a tag on a page. */
export function Evidence({ label, text }: { label: string; text: string }) {
  return (
    <Section label={label}>
      <pre className="m-0 overflow-x-auto rounded-lg border border-line bg-paper px-3 py-2.5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">
        {text}
      </pre>
    </Section>
  )
}

/** A dashed aside: what the console will not show, or what an action will also do. */
export function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 rounded-[10px] border border-dashed border-thumb px-3 py-[9px] text-[12.5px] leading-normal text-muted">
      {children}
    </p>
  )
}

/** When something happened, relative while recent. */
export function useWhen(): (at: number | null) => string {
  const locale = useLocale()
  return (at) => relativeTime(at, locale)
}

/**
 * What operators did to this record, newest first. `describe` may give an entry's words (a
 * listing's new value, say); otherwise it reads as the action's past tense.
 */
export function History({
  entries,
  describe,
}: {
  entries: readonly AdminHistoryEntry[]
  describe?: (entry: AdminHistoryEntry) => string | undefined
}) {
  const t = useTranslations('admin.shell')
  const when = useWhen()
  if (entries.length === 0) return null
  const words = (entry: AdminHistoryEntry) => {
    const own = describe?.(entry)
    if (own) return own
    if (entry.action === 'undo') {
      return entry.undid
        ? t('ledger.undo', { action: t(`actions.${entry.undid}.done`) })
        : t('toast.undone')
    }
    if (entry.action === 'admin.grant' || entry.action === 'admin.ungrant') return entry.action
    return t(`actions.${entry.action}.done`)
  }
  return (
    <Section label={t('ledger.history')}>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 text-[13px] leading-normal"
          >
            <span className="text-muted">{when(entry.at)}</span>
            <span className="text-ink-2">
              {words(entry)}
              {' · '}
              {entry.actor ? `@${entry.actor.handle}` : t('ledger.byCli')}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  )
}
