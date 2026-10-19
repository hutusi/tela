import { type RefObject, useId } from 'react'
import { useTranslations } from 'use-intl'
import { ResponsiveDialog } from './modal'

type What =
  | 'next'
  | 'previous'
  | 'close'
  | 'original'
  | 'like'
  | 'read'
  | 'undo'
  | 'highlight'
  | 'sidebar'
  | 'focus'
  | 'help'

const KEYS: [string, What][] = [
  ['j', 'next'],
  ['k', 'previous'],
  ['Esc', 'close'],
  ['o', 'original'],
  ['l', 'like'],
  ['m', 'read'],
  ['u', 'undo'],
  ['h', 'highlight'],
  ['[', 'sidebar'],
  ['f', 'focus'],
  ['?', 'help'],
]

/**
 * What the keys do on /reading (`?` shows it; Esc or the button hides it). A dialog like any
 * other (`ResponsiveDialog`): focus goes into it, and back to where `?` was pressed as it closes;
 * a floating card had left focus behind it, and Esc to the page.
 */
export function Shortcuts({
  opener,
  onClose,
}: {
  /** What had focus as `?` was pressed. */
  opener: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const t = useTranslations('keys')
  const titleId = useId()
  return (
    <ResponsiveDialog
      labelledBy={titleId}
      opener={opener}
      onClose={onClose}
      testId="shortcuts"
      width="w-[min(320px,calc(100vw-32px))]"
    >
      <h2 id={titleId} className="mt-0 mb-3 font-serif text-[20px] font-medium">
        {t('title')}
      </h2>
      <dl className="m-0 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[13.5px]">
        {KEYS.map(([key, what]) => (
          <div key={key} className="contents">
            <dt>
              <kbd className="inline-block min-w-7 rounded-md border border-line bg-paper px-1.5 py-0.5 text-center font-mono text-[12px] text-ink">
                {key}
              </kbd>
            </dt>
            <dd className="m-0 text-ink-2">{t(what)}</dd>
          </div>
        ))}
      </dl>
      <div>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 rounded-full border border-line px-3.5 py-1.5 text-[13px] hover:border-ink"
        >
          {t('dismiss')}
        </button>
      </div>
    </ResponsiveDialog>
  )
}
