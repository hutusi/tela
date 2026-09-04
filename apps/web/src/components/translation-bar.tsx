import { LANGUAGE_NAMES, type UiLocale } from '@tela/shared'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { type ReadingMode, type ReadingParams, readingHref } from '@/app/reading/href'

export type TranslationView = {
  targetLang: string
  state: 'none' | 'requested' | 'running' | 'done' | 'partial' | 'failed'
  failedBlocks: number
}

const MODES: ReadingMode[] = ['side', 'trans', 'orig']

/** "Written in Spanish. Translated to English by Tela." plus the mode toggle and status. */
export async function TranslationBar({
  sourceLang,
  view,
  params,
}: {
  sourceLang: string
  view: TranslationView
  params: ReadingParams
}) {
  const [t, locale] = await Promise.all([getTranslations('translation'), getLocale()])
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  const sourceName = names[sourceLang] ?? sourceLang
  const targetName = names[view.targetLang] ?? view.targetLang
  const ready = view.state === 'done' || view.state === 'partial'
  return (
    <div
      className="mb-7 flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-[10px] border border-line bg-white px-3.5 py-2.5 text-[13px]"
      data-testid="translation-bar"
      data-state={view.state}
    >
      <span className="text-ink-2">
        {t.rich('writtenIn', {
          source: sourceName,
          target: targetName,
          b: (chunks) => <b className="font-medium text-ink">{chunks}</b>,
        })}
        {view.state === 'requested' || view.state === 'running' ? ` ${t('translating')}` : null}
        {view.state === 'failed' ? ` ${t('failed')}` : null}
        {view.state === 'partial' ? ` ${t('partial', { n: view.failedBlocks })}` : null}
      </span>
      <div className="flex-1" />
      <div className="flex gap-0.5 rounded-lg bg-paper p-0.5">
        {MODES.map((mode) => {
          const active = params.mode === mode
          const disabled = !ready && mode !== 'orig'
          return (
            <Link
              key={mode}
              href={readingHref({ ...params, mode })}
              aria-current={active ? 'true' : undefined}
              aria-disabled={disabled ? 'true' : undefined}
              data-testid={`mode-${mode}`}
              className={`rounded-md px-2.5 py-[5px] text-[12.5px] hover:no-underline ${
                active
                  ? 'bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                  : 'text-muted hover:text-ink'
              } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
            >
              {t(`modes.${mode}`)}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
