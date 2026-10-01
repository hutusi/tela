import type { ReactNode } from 'react'

/**
 * A 16px glyph in the sidebar's line style: drawn here, since Tela has no icon set (DESIGN.md).
 * The rail's filters and the Manage link beside Subscriptions draw inside it.
 */
export function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
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
