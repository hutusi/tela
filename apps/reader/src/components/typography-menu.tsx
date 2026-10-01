/**
 * "Aa": text size, line length and theme. The controls are shared by the reader's menu and the
 * settings page; each is a synced pref, applied at once.
 */
import { useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import {
  MEASURES,
  type Measure,
  PREFS,
  SIZES,
  type Size,
  THEMES,
  typographyOf,
} from '../lib/typography'
import { useDismiss } from '../lib/use-dismiss'
import { useStore, useTables } from '../store/hooks'

function Choice<T extends string>({
  label,
  options,
  value,
  render,
  onChoose,
  testId,
}: {
  label: string
  options: readonly T[]
  value: T
  render: (option: T) => React.ReactNode
  onChoose: (option: T) => void
  testId: string
}) {
  return (
    <fieldset className="m-0 flex min-w-0 items-center justify-between gap-3 border-0 p-0">
      <legend className="float-left text-[12.5px] text-muted">{label}</legend>
      <div className="flex rounded-full border border-line p-0.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === value}
            onClick={() => onChoose(option)}
            data-testid={`${testId}-${option}`}
            className={`min-w-9 rounded-full px-2.5 py-1 text-[12.5px] ${
              option === value ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-hover'
            }`}
          >
            {render(option)}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

export function TypographyControls() {
  const t = useTranslations('typography')
  const tables = useTables()
  const { store } = useStore()
  const { size, measure, theme } = typographyOf(tables)
  const set = (key: string, value: string) => store.mutate({ type: 'setPref', key, value })
  return (
    <div className="flex flex-col gap-3" data-testid="typography-controls">
      <Choice
        label={t('size')}
        options={Object.keys(SIZES) as Size[]}
        value={size}
        render={(s) => (
          <span style={{ fontSize: `${11 + Object.keys(SIZES).indexOf(s) * 2}px` }}>A</span>
        )}
        onChoose={(s) => set(PREFS.size, s)}
        testId="size"
      />
      <Choice
        label={t('measure')}
        options={Object.keys(MEASURES) as Measure[]}
        value={measure}
        render={(m) => t(`measures.${m}`)}
        onChoose={(m) => set(PREFS.measure, m)}
        testId="measure"
      />
      <Choice
        label={t('theme')}
        options={THEMES}
        value={theme}
        render={(th) => t(`themes.${th}`)}
        onChoose={(th) => set(PREFS.theme, th)}
        testId="theme"
      />
    </div>
  )
}

export function TypographyMenu() {
  const t = useTranslations('typography')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // Esc closes the menu, and only the menu: the reader's own Esc closes the article.
  useDismiss(open, () => setOpen(false), box)
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('label')}
        title={t('label')}
        onClick={() => setOpen((o) => !o)}
        data-testid="typography-button"
        className="rounded-full border border-thumb px-3 py-[7px] font-serif font-medium text-ink hover:border-ink"
      >
        Aa
      </button>
      {open ? (
        <div
          className="absolute right-0 top-[calc(100%+8px)] z-[6] w-72 rounded-xl border border-line bg-surface p-3.5 shadow-[0_12px_32px_rgba(0,0,0,.10)] animate-fade"
          data-testid="typography-menu"
        >
          <TypographyControls />
        </div>
      ) : null}
    </div>
  )
}
