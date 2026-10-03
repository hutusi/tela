/**
 * "Read in EN ▾": a visitor's language, in the header and on the sign-in page (ADR 0035). It sets
 * the interface language, and with it the language titles are translated into, since a visitor
 * reads in their interface language (`useReadingLang`). A member has Settings → Language and the
 * Read-in menu instead.
 *
 * A native `<details>`, as Discover's language menu is, so it opens in the edge's page before any
 * script runs; choosing needs the script, which writes the cookie the edge renders by.
 */
import { LANGUAGE_NAMES, UI_LOCALES } from '@tela/shared'
import { useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { pillLabel } from '../lib/format'
import { useDismiss } from '../lib/use-dismiss'
import { useUi } from '../ui'

const item = (on: boolean) =>
  `rounded-md px-2.5 py-[7px] text-left text-[13px] text-ink hover:bg-hover ${on ? 'bg-hover font-medium' : ''}`

export function VisitorLocale({ className = '' }: { className?: string }) {
  const t = useTranslations('nav')
  const { locale, setLocale } = useUi()
  const box = useRef<HTMLDetailsElement>(null)
  // Whether it is open, as the element says: it opens without React, from its summary.
  const [open, setOpen] = useState(false)
  const close = (by: 'escape' | 'outside') => {
    const details = box.current
    if (!details) return
    details.open = false
    if (by === 'escape') details.querySelector('summary')?.focus()
  }
  // Only while open: its Esc is taken before anything else's, a dialog's included.
  useDismiss(open, close, box)
  return (
    <details
      ref={box}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={`relative ${className}`}
      data-testid="visitor-locale"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-3 py-1.5 text-[13px] font-medium text-ink hover:border-muted">
        <span className="font-normal text-muted">{t('readIn')}</span>
        {pillLabel(locale)}
        <span aria-hidden="true" className="text-[10px] text-muted">
          ▾
        </span>
      </summary>
      <div className="absolute right-0 top-[calc(100%+6px)] z-[7] flex min-w-[160px] animate-fade flex-col rounded-[10px] border border-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,.08)]">
        {UI_LOCALES.map((code) => (
          <button
            key={code}
            type="button"
            lang={code}
            aria-pressed={code === locale}
            onClick={() => {
              setLocale(code)
              close('outside')
            }}
            data-testid={`visitor-locale-${code}`}
            className={item(code === locale)}
          >
            {/* Each language in its own name, so it can be found whatever the page is in. */}
            {LANGUAGE_NAMES[code][code]}
          </button>
        ))}
      </div>
    </details>
  )
}
