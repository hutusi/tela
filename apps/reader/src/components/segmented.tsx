/**
 * One of a few named values, side by side, the chosen one lifted (Settings, DESIGN.md). `value`
 * null marks none, where the page cannot say which (the edge's, for the theme). `large` is the
 * phone's size, for a row of a menu or the footer (Tela v5): 13px, and items tall enough to touch.
 * `tall` is the reading list's Unread / All: medium weight, and on a phone 36px items at 13px
 * (Tela Mobile 01 and 18).
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  render,
  onChoose,
  testId,
  large = false,
  tall = false,
}: {
  label: string
  options: readonly T[]
  value: T | null
  render: (option: T) => React.ReactNode
  onChoose: (option: T) => void
  testId: string
  large?: boolean
  tall?: boolean
}) {
  return (
    <fieldset
      className="m-0 flex min-w-0 shrink-0 gap-0.5 rounded-lg border-0 bg-hover p-0.5"
      aria-label={label}
    >
      {options.map((option) => {
        const active = option === value
        return (
          <button
            key={option}
            type="button"
            aria-pressed={value === null ? undefined : active}
            onClick={() => onChoose(option)}
            data-testid={`${testId}-${option}`}
            className={`rounded-md whitespace-nowrap ${
              large ? 'px-[11px] py-[7px] text-[13px]' : 'px-3 py-[5px] text-[12.5px]'
            } ${tall ? 'font-medium max-md:min-h-9 max-md:px-3.5 max-md:text-[13px]' : ''} ${
              active
                ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]'
                : 'text-ink-2 hover:text-ink'
            }`}
          >
            {render(option)}
          </button>
        )
      })}
    </fieldset>
  )
}
