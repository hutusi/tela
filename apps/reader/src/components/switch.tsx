/**
 * An on/off setting that takes effect at once: a button with the switch role, never a form field.
 * One that has to wait stays focusable, so its reason (`describedBy`) can be heard, and does
 * nothing when pressed.
 */
export function Switch({
  checked,
  onChange,
  label,
  testId,
  disabled = false,
  describedBy,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  testId: string
  disabled?: boolean
  describedBy?: string | undefined
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled ? 'true' : undefined}
      aria-describedby={describedBy}
      onClick={() => {
        if (!disabled) onChange(!checked)
      }}
      data-testid={testId}
      className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-thumb'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <span
        className={`absolute top-[3px] left-[3px] size-[18px] rounded-full bg-knob shadow-[0_1px_2px_rgba(0,0,0,.2)] transition-transform ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  )
}
