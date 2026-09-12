import { UI_LOCALES } from '@tela/shared'
import { setLocale } from '@/app/locale-actions'

const LABELS: Record<string, string> = { en: 'EN', 'zh-Hans': '中文' }

/** Switches the UI locale (a cookie); the reading language is a separate setting. */
export function LocaleSwitcher({ locale }: { locale: string }) {
  return (
    <form
      action={setLocale}
      data-testid="locale-switcher"
      className="flex rounded-full border border-line bg-white p-0.5 text-[12px] font-medium sm:shrink-0"
    >
      {UI_LOCALES.map((code) => (
        <button
          key={code}
          type="submit"
          name="locale"
          value={code}
          aria-pressed={code === locale}
          className={`rounded-full px-2.5 py-1 ${code === locale ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-hover'}`}
        >
          {LABELS[code] ?? code}
        </button>
      ))}
    </form>
  )
}
