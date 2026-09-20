'use client'

import { LANGUAGE_NAMES, type UiLocale } from '@tela/shared'
import { useLocale, useTranslations } from 'next-intl'
import type { ReadingMode } from '@/app/reading/href'
import type { ReaderTranslationState } from './reader-data'

export type TranslationView = {
  targetLang: string
  state: ReaderTranslationState
  failedBlocks: number
}

const MODES: ReadingMode[] = ['side', 'trans', 'orig']

/**
 * "Written in Spanish. Translated to English by Tela." plus the mode toggle and status.
 *
 * The mode toggle is buttons rather than links: switching between side-by-side, translation and
 * original changes nothing the server knows, and routing it through a navigation cost a full page
 * render (ADR 0017). The URL still follows, so the view stays shareable.
 */
export function TranslationBar({
  sourceLang,
  view,
  mode,
  onMode,
}: {
  sourceLang: string
  view: TranslationView
  mode: ReadingMode
  onMode: (mode: ReadingMode) => void
}) {
  const t = useTranslations('translation')
  const locale = useLocale()
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
      </span>
      {/* Its own live region: the sentence above is static, and re-announcing "Written in
          Japanese" every time the status moves would bury the part that changed. */}
      <span className="text-ink-2" aria-live="polite" data-testid="translation-status">
        {view.state === 'requested' || view.state === 'running' ? t('translating') : null}
        {view.state === 'failed' ? t('failed') : null}
        {view.state === 'partial' ? t('partial', { n: view.failedBlocks }) : null}
      </span>
      <div className="flex-1" />
      {/* A fieldset rather than role="group": same semantics, and the one Biome asks for. */}
      <fieldset
        className="flex min-w-0 gap-0.5 rounded-lg bg-paper p-0.5"
        aria-label={t('modesLabel')}
      >
        {MODES.map((m) => {
          const active = mode === m
          const disabled = !ready && m !== 'orig'
          return (
            <button
              key={m}
              type="button"
              disabled={disabled}
              onClick={() => onMode(m)}
              aria-current={active ? 'true' : undefined}
              aria-disabled={disabled ? 'true' : undefined}
              data-testid={`mode-${m}`}
              className={`rounded-md px-2.5 py-[5px] text-[12.5px] ${
                active
                  ? 'bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                  : 'text-muted hover:text-ink'
              } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
            >
              {t(`modes.${m}`)}
            </button>
          )
        })}
      </fieldset>
    </div>
  )
}
