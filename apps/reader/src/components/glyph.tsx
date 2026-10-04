import type { ReactNode } from 'react'

/**
 * A 16px glyph in the sidebar's line style: drawn here, since Tela has no icon set (DESIGN.md).
 * The rail's filters, the Manage link beside Subscriptions and the header's theme menu draw inside
 * it.
 */
export function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Two sliders, each line broken where its knob sits: "adjust these". */
export const SLIDERS = (
  <>
    <path d="M2.5 5h6.25M12.25 5h1.25M2.5 11h1.25M7.25 11h6.25" />
    <circle cx="10.5" cy="5" r="1.75" />
    <circle cx="5.5" cy="11" r="1.75" />
  </>
)

/** A sun and its eight rays: the light theme, chosen. */
export const SUN = (
  <>
    <circle cx="8" cy="8" r="2.5" />
    <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
  </>
)

/** A crescent, its hollow to the upper right: the dark theme, chosen. */
export const MOON = <path d="M13.75 8.5A5.75 5.75 0 1 1 7.5 2.25 4.5 4.5 0 0 0 13.75 8.5Z" />

/** A circle, its right half filled: Auto, light or dark as the system says. */
export const AUTO = (
  <>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 2.25a5.75 5.75 0 0 1 0 11.5Z" fill="currentColor" />
  </>
)
