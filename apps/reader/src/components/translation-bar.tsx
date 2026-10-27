import { LANGUAGE_NAMES, type UiLocale } from '@tela/shared'
import { useLocale, useTranslations } from 'use-intl'
import type { ReadingMode } from '../lib/href'
export type ReaderTranslationState =
  | 'none'
  /** Asked for, and put off to the next UTC day (ADR 0057). */
  | 'waiting'
  | 'requested'
  | 'running'
  | 'done'
  | 'partial'
  | 'failed'

export type TranslationView = {
  targetLang: string
  state: ReaderTranslationState
  failedBlocks: number
  /** Something to show beside the original: the finished translation, or chunks still arriving. */
  available: boolean
  /** When a waiting translation falls due; null unless `state` is `waiting`. */
  dueAt?: number | null
}

const DAY_MS = 86_400_000

/** The day `at` falls on where the member is, as a whole number of days. */
const localDay = (at: number) => {
  const d = new Date(at)
  return Math.floor((at - d.getTimezoneOffset() * 60_000) / DAY_MS)
}

/**
 * A moment as the member's own clock reads it, and whether that is tomorrow where they are: the
 * next UTC midnight is 08:00 in Beijing and 01:00 in Paris.
 */
export function localTime(
  at: number,
  locale: string,
  now: number = Date.now(),
): { time: string; tomorrow: boolean } {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(at),
  )
  return { time, tomorrow: localDay(at) > localDay(now) }
}

/** "Tela will translate this after 08:00", in the member's own time, and "tomorrow" when so. */
export function waitingLine(
  t: (key: 'waitingToday' | 'waitingTomorrow', values: { time: string }) => string,
  dueAt: number,
  locale: string,
  now: number = Date.now(),
): string {
  const { time, tomorrow } = localTime(dueAt, locale, now)
  return t(tomorrow ? 'waitingTomorrow' : 'waitingToday', { time })
}

const MODES: ReadingMode[] = ['side', 'trans', 'orig']

/** The bar's one button in place of the modes: Translate, or Try translating again. */
const ACTION = 'rounded-lg bg-paper px-3 py-[5px] text-[12.5px] font-medium text-ink hover:bg-hover'

/**
 * "Written in Spanish." then where its translation stands, plus the mode toggle (Tela v5):
 * translating into English, translated by Tela (some paragraphs perhaps not), or failed, with a
 * way to try again in the toggle's place. Translating only when asked, the toggle's place is the
 * Translate button.
 *
 * The mode toggle is buttons: switching changes nothing the server knows. The URL still follows,
 * so the view stays shareable. Below `lg` the sentence is on top and the toggle under it, the
 * width of the bar (Tela Mobile 03).
 */
export function TranslationBar({
  sourceLang,
  view,
  mode,
  onMode,
  onTranslate,
  onRetry,
}: {
  sourceLang: string
  view: TranslationView
  mode: ReadingMode
  onMode: (mode: ReadingMode) => void
  /** Set while the member translates only when asked: a Translate button stands in the toggle. */
  onTranslate?: (() => void) | undefined
  /** Set when it failed, or could not be asked for: Try translating again, before the modes. */
  onRetry?: (() => void) | undefined
}) {
  const t = useTranslations('translation')
  const locale = useLocale()
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  const sourceName = names[sourceLang] ?? sourceLang
  const targetName = names[view.targetLang] ?? view.targetLang
  const ready = view.available
  const status =
    view.state === 'waiting' && view.dueAt
      ? waitingLine(t, view.dueAt, locale)
      : view.state === 'done'
        ? t('translatedBy', { target: targetName })
        : view.state === 'partial'
          ? t('partial', { target: targetName, n: view.failedBlocks })
          : view.state === 'requested' || view.state === 'running'
            ? t('translatingInto', { target: targetName })
            : view.state === 'failed'
              ? t('failed')
              : null
  return (
    <div
      className="mb-7 flex flex-col gap-2.5 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-[13px] lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-3.5 lg:px-3.5"
      data-testid="translation-bar"
      data-state={view.state}
    >
      <p className="m-0 min-w-0 text-ink-2">
        {t.rich('writtenIn', {
          source: sourceName,
          b: (chunks) => <b className="font-medium text-ink">{chunks}</b>,
        })}
        {/* Its own live region: the sentence before it is static, and re-announcing "Written in
            Japanese" every time the status moves would bury the part that changed. */}
        <span className="ms-1" aria-live="polite" data-testid="translation-status">
          {status}
        </span>
      </p>
      <div className="hidden flex-1 lg:block" />
      {onTranslate ? (
        <button type="button" onClick={onTranslate} className={ACTION} data-testid="translate-now">
          {t('translateNow', { target: targetName })}
        </button>
      ) : null}
      {!onTranslate && onRetry ? (
        <button type="button" onClick={onRetry} className={ACTION} data-testid="translation-retry">
          {t('retry')}
        </button>
      ) : null}
      {/* Nothing to switch to while it failed with nothing to show: only the way to try again. */}
      {onTranslate || (onRetry && !ready) ? null : (
        /* A fieldset rather than role="group": same semantics, and the one Biome asks for. */
        <fieldset
          className="flex w-full min-w-0 gap-0.5 rounded-lg bg-paper p-0.5 lg:w-auto"
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
                className={`flex-1 rounded-md px-2.5 py-[7px] text-[12.5px] lg:flex-none lg:py-[5px] ${
                  active
                    ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                    : 'text-muted hover:text-ink'
                } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
              >
                {t(`modes.${m}`)}
              </button>
            )
          })}
        </fieldset>
      )}
    </div>
  )
}
