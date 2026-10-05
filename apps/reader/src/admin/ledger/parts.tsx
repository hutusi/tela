/** The pieces above and below a ledger's table: its header, the filter pills, the search, the keys. */
import type { LedgerArea } from '@tela/shared/admin'
import { type RefObject, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { Kbd } from '../components/buttons'
import { AREA_GROUP } from '../nav'

/** What the search waits for after the last key before it asks the server. */
export const SEARCH_DEBOUNCE_MS = 200

/** Group, title and what the area is for, as the design heads each board. */
export function AreaHeader({ area }: { area: LedgerArea }) {
  const t = useTranslations('admin.shell')
  return (
    <header className="flex flex-col gap-1.5">
      <div className="text-[11px] font-semibold tracking-[.1em] text-accent uppercase">
        {t(`groups.${AREA_GROUP[area]}`)}
      </div>
      <h1 className="m-0 font-serif text-[34px] leading-[1.05] font-medium tracking-[-0.015em] md:text-[40px]">
        {t(`nav.${area}`)}
      </h1>
      <p className="m-0 max-w-[680px] text-[14.5px] leading-normal text-ink-2">
        {t(`about.${area}`)}
      </p>
    </header>
  )
}

export function FilterPills<F extends string>({
  filters,
  active,
  label,
  counts,
  onChoose,
}: {
  filters: readonly F[]
  active: F
  label: (filter: F) => string
  counts: Partial<Record<F, number>> | null
  onChoose: (filter: F) => void
}) {
  return (
    <div className="mt-6 flex flex-wrap gap-1.5">
      {filters.map((filter) => {
        const on = filter === active
        const n = counts?.[filter]
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={on}
            onClick={() => onChoose(filter)}
            className={`flex shrink-0 cursor-pointer items-baseline gap-[7px] rounded-full border px-[13px] py-[5px] text-[13.5px] font-medium whitespace-nowrap ${on ? 'border-ink bg-ink text-paper' : 'border-thumb text-ink-2 hover:border-muted hover:text-ink'}`}
            data-testid="admin-filter"
            data-filter={filter}
          >
            {label(filter)}
            {n !== undefined ? (
              <span className={`text-[12px] tabular-nums ${on ? 'text-paper' : 'text-muted'}`}>
                {n}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The search box. The address owns the search; the box holds only what is being typed until it has
 * rested for a moment, then hands it over. When the address changes by itself (Back, a link), the
 * box shows what it now says.
 */
export function SearchBox({
  value,
  hint,
  inputRef,
  onSearch,
}: {
  value: string
  hint: string
  inputRef: RefObject<HTMLInputElement | null>
  onSearch: (q: string) => void
}) {
  const t = useTranslations('admin.shell')
  const [draft, setDraft] = useState(value)
  // The last search handed to the address, to tell its own change from someone else's.
  const handed = useRef(value)
  const latest = useRef(onSearch)
  latest.current = onSearch
  useEffect(() => {
    if (value === handed.current) return
    handed.current = value
    setDraft(value)
  }, [value])
  useEffect(() => {
    const q = draft.trim()
    if (q === handed.current) return
    const timer = setTimeout(() => {
      handed.current = q
      latest.current(q)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft])
  return (
    <div className="flex w-[360px] max-w-full min-w-0 items-center gap-2 rounded-lg border border-thumb bg-surface pr-2 pl-3 focus-within:border-muted">
      <span aria-hidden="true" className="text-muted">
        ⌕
      </span>
      <input
        ref={inputRef}
        type="search"
        value={draft}
        placeholder={hint}
        aria-label={t('ledger.search')}
        onChange={(e) => setDraft(e.target.value)}
        className="min-w-0 flex-1 border-0 bg-transparent py-2 text-[13.5px] text-ink outline-none placeholder:text-muted"
        data-testid="admin-search"
      />
      <Kbd>/</Kbd>
    </div>
  )
}

/** The keys, under the table. */
export function KeyLegend() {
  const t = useTranslations('admin.shell')
  const keys: [string, string][] = [
    ['J K', t('keys.move')],
    ['X', t('keys.select')],
    ['↵', t('keys.open')],
    ['1–3', t('keys.act')],
    ['U', t('keys.undo')],
    ['/', t('keys.search')],
    ['Esc', t('keys.close')],
  ]
  return (
    <div className="hidden flex-wrap gap-4 px-0.5 text-[12px] text-muted md:flex">
      {keys.map(([key, words]) => (
        <span key={key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <Kbd>{key}</Kbd>
          {words}
        </span>
      ))}
    </div>
  )
}
