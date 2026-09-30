import { useTranslations } from 'use-intl'

const KEYS: [string, 'next' | 'previous' | 'close' | 'highlight' | 'sidebar' | 'help'][] = [
  ['j', 'next'],
  ['k', 'previous'],
  ['Esc', 'close'],
  ['h', 'highlight'],
  ['[', 'sidebar'],
  ['?', 'help'],
]

/** What the keys do on /reading (`?` shows it; Esc or the button hides it). */
export function Shortcuts({ onClose }: { onClose: () => void }) {
  const t = useTranslations('keys')
  return (
    <div
      role="dialog"
      aria-label={t('title')}
      data-testid="shortcuts"
      className="fixed left-1/2 top-24 z-30 w-72 -translate-x-1/2 rounded-xl border border-line bg-surface p-5 shadow-[0_16px_40px_rgba(0,0,0,.16)] animate-fade"
    >
      <h2 className="mb-3 font-serif text-[20px] font-medium">{t('title')}</h2>
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
      <button
        type="button"
        onClick={onClose}
        className="mt-4 rounded-full border border-line px-3.5 py-1.5 text-[13px] hover:border-ink"
      >
        {t('dismiss')}
      </button>
    </div>
  )
}
