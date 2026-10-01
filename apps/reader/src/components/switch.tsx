/** An on/off setting that takes effect at once: a button with the switch role, never a form field. */
export function Switch({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  testId: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-thumb'}`}
    >
      <span
        className={`absolute top-[3px] left-[3px] size-[18px] rounded-full bg-knob shadow-[0_1px_2px_rgba(0,0,0,.2)] transition-transform ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  )
}
