/** One of a few named values, side by side, the chosen one lifted (Settings, DESIGN.md). */
export function Segmented<T extends string>({
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
            aria-pressed={active}
            onClick={() => onChoose(option)}
            data-testid={`${testId}-${option}`}
            className={`rounded-md px-3 py-[5px] text-[12.5px] whitespace-nowrap ${
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
