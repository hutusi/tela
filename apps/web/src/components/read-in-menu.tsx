import { languageBadge, READING_LANGUAGES } from '@tela/shared'
import { getTranslations } from 'next-intl/server'
import { setReadingLang } from '@/app/reading-lang-actions'

/** "Read in EN / ZH": the language posts are translated into. Separate from the UI locale. */
export async function ReadInMenu({ readingLang }: { readingLang: string }) {
  const t = await getTranslations('nav')
  return (
    <form
      action={setReadingLang}
      className="flex items-center gap-1.5 rounded-full border border-line bg-white py-0.5 pl-3 pr-0.5 text-[12px] font-medium"
      data-testid="read-in"
    >
      <span className="text-muted">{t('readIn')}</span>
      {READING_LANGUAGES.map((code) => (
        <button
          key={code}
          type="submit"
          name="lang"
          value={code}
          aria-pressed={code === readingLang}
          className={`rounded-full px-2 py-1 ${code === readingLang ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-hover'}`}
        >
          {languageBadge(code)}
        </button>
      ))}
    </form>
  )
}
