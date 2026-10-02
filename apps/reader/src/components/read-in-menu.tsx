import { READING_LANGUAGES } from '@tela/shared'
import { useTranslations } from 'use-intl'
import { pillLabel } from '../lib/format'
import { useStore } from '../store/hooks'

/** "Read in 中文 EN": the language posts are translated into. The UI locale is in Settings. */
export function ReadInMenu({ readingLang }: { readingLang: string }) {
  const t = useTranslations('nav')
  const { store } = useStore()
  return (
    <div
      className="flex items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pl-3 pr-0.5 text-[12px] font-medium sm:shrink-0"
      data-testid="read-in"
    >
      <span className="text-muted">{t('readIn')}</span>
      {READING_LANGUAGES.map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => store.mutate({ type: 'setProfile', readingLang: code })}
          aria-pressed={code === readingLang}
          className={`rounded-full px-2 py-1 whitespace-nowrap ${code === readingLang ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-hover'}`}
        >
          {pillLabel(code)}
        </button>
      ))}
    </div>
  )
}
