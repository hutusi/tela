import { UI_LOCALES } from '@tela/shared'
import { pillLabel } from '../lib/format'
import { useUi } from '../ui'

/**
 * Switches the UI locale (a cookie, and the profile for members); reading language is separate.
 * Only the sign-in page shows it: a member changes it in Settings, and a visitor's browser decides.
 */
export function LocaleSwitcher() {
  const { locale, setLocale } = useUi()
  return (
    <div
      data-testid="locale-switcher"
      className="flex rounded-full border border-line bg-surface p-0.5 text-[12px] font-medium sm:shrink-0"
    >
      {UI_LOCALES.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLocale(code)}
          aria-pressed={code === locale}
          className={`rounded-full px-2.5 py-1 ${code === locale ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-hover'}`}
        >
          {pillLabel(code)}
        </button>
      ))}
    </div>
  )
}
