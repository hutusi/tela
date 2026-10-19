import type { ReactNode } from 'react'

/**
 * Tela's icons: line drawings on a 16px grid, in one style (1.5 stroke, round caps and joins,
 * `currentColor`), so they sit in text at any weight and take the colour around them. They replace
 * the typed glyphs (♡ ↗ ⌕ ✕ ▾ ✓) the reader used to print, which each platform's fonts drew
 * differently or not at all: ⌕ is missing from many, and ♥ turns into an emoji on some (Tela v5).
 *
 * `size` scales the box; `viewBox` is only for a shape drawn on another grid (GEAR's 24). An icon
 * is decoration: the control it sits in carries the name, in its text or its label.
 */
export function Glyph({
  children,
  className,
  size = 16,
  viewBox = '0 0 16 16',
  strokeWidth = 1.5,
}: {
  children: ReactNode
  className?: string
  size?: number
  viewBox?: string
  strokeWidth?: number
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

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

const HEART_PATH =
  'M8 13.5S2.5 10.2 2.5 6.1A2.85 2.85 0 0 1 8 4.6a2.85 2.85 0 0 1 5.5 1.5C13.5 10.2 8 13.5 8 13.5Z'

/** A heart: a like, and the Liked filter. */
export const HEART = <path d={HEART_PATH} />

/** The heart filled: liked. */
export const HEART_FILLED = <path d={HEART_PATH} fill="currentColor" />

/** An arrow passing a post on: Recommend. Never ↗, which means only a link that leaves Tela. */
export const PASS = (
  <>
    <path d="M9.5 3.5 13 7l-3.5 3.5" />
    <path d="M13 7H7.5A4.5 4.5 0 0 0 3 11.5v1" />
  </>
)

/** A lens: search. */
export const SEARCH = (
  <>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.25 3.25" />
  </>
)

/** A cross: close, or remove. */
export const CLOSE = <path d="m4 4 8 8M12 4l-8 8" />

/** A chevron pointing down: a list that opens below. Drawn at 12px. */
export const CHEVRON_DOWN = <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />

/** A chevron pointing right: a list that opens in place of this one. Drawn at 14px. */
export const CHEVRON_RIGHT = <path d="m6 3.5 4.5 4.5L6 12.5" />

/** A tick: done, chosen, claimed. Drawn at 12px. */
export const CHECK = <path d="m3.5 8.5 3 3 6-7" />

/** Three lines: All articles, and Settings' All blogs. */
export const LIST = <path d="M3 4.5h10M3 8h10M3 11.5h10" />

/** A padlock: a blogroll only its owner can open. */
export const LOCK = (
  <>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
    <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
  </>
)

/** A chevron pointing left: back. */
export const BACK = <path d="M10 3.5 5.5 8l4.5 4.5" />

/** An arrow out of the corner: a link that leaves Tela, such as the original post. */
export const EXTERNAL = <path d="M6.5 3.5h6v6M12.5 3.5 4 12" />

/**
 * A gear: settings, such as Manage subscriptions. Lucide's "settings" icon, drawn on its 24px
 * grid: pass `viewBox={GEAR_VIEWBOX}` and `strokeWidth={2.1}`.
 * Lucide is ISC-licensed: Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as
 * part of Feather (MIT); all other copyright (c) for Lucide are held by Lucide Contributors 2022.
 */
export const GEAR = (
  <>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </>
)
export const GEAR_VIEWBOX = '0 0 24 24'
