/**
 * The console's small controls, as the design's 2a board draws them: round action buttons (the
 * likeliest filled, a taking-away one in `danger`, the rest quiet), the key chip a button or the
 * legend shows, and the row's check box. Tokens only, so the dark ground follows.
 */
import type { ComponentProps } from 'react'

export type Look = 'primary' | 'danger' | 'ghost'

const LOOK: Record<Look, string> = {
  primary: 'border-primary bg-primary text-on-primary hover:brightness-110',
  danger: 'border-thumb text-danger hover:border-muted',
  ghost: 'border-thumb text-ink hover:border-muted',
}

const SIZE = {
  md: 'gap-2 px-3.5 py-[7px] text-[13px]',
  sm: 'px-[11px] py-[3px] text-[12.5px]',
} as const

export function ActionButton({
  look,
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ComponentProps<'button'> & { look: Look; size?: keyof typeof SIZE }) {
  return (
    <button
      type={type}
      className={`inline-flex max-w-full shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border font-semibold whitespace-nowrap disabled:cursor-default disabled:opacity-60 ${LOOK[look]} ${SIZE[size]} ${className}`}
      {...rest}
    />
  )
}

/** The key that does the same, inside a button: in the button's own colour. */
export function KeyHint({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-[4px] border border-current px-1 font-sans text-[10.5px] leading-[1.35] font-semibold opacity-80">
      {children}
    </kbd>
  )
}

/** A key in the legend under a table, and in the search box's hint. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-block min-w-[18px] rounded-[4px] border border-thumb px-[5px] text-center font-sans text-[11px] font-semibold whitespace-nowrap text-ink-2">
      {children}
    </kbd>
  )
}

/**
 * A row's check, and the header's check-all: a real checkbox drawn as a 16px box, filled in the
 * accent once checked. Its look comes from its props, not `checked:` and `hover:` variants, which
 * would set one property under two variants with no defined winner (AGENTS gotchas).
 */
export function CheckBox({
  checked,
  label,
  onToggle,
  mixed = false,
}: {
  checked: boolean
  label: string
  onToggle: () => void
  /** Some rows checked, not all: the header's box. */
  mixed?: boolean
}) {
  const on = checked || mixed
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: only stops the click reaching the row, which would open it; the box itself takes Space
    <label
      className="relative flex size-4 shrink-0 cursor-pointer items-center justify-center"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        ref={(box) => {
          if (box) box.indeterminate = mixed
        }}
        onChange={onToggle}
        className={`absolute inset-0 m-0 cursor-pointer appearance-none rounded-[4px] border-[1.5px] ${on ? 'border-accent bg-accent' : 'border-thumb bg-transparent hover:border-muted'}`}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none relative text-[11px] leading-none font-semibold text-paper"
      >
        {checked ? '✓' : mixed ? '–' : ''}
      </span>
    </label>
  )
}
