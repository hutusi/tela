/**
 * The Tela mark: two mirrored strands that both pass through the centre, so it balances whichever
 * way it flips. From the Claude Design file `Tela Logo.dc.html`, turn 4 — see docs/DESIGN.md.
 *
 * This is the transparent form, which is the primary one: the strands sit directly on whatever is
 * behind them. The tiled form (a dark rounded square) exists only as `app/icon.svg`, `favicon.ico`
 * and `app/apple-icon.png`, where the mark needs a shape of its own.
 *
 * The ink strand is `currentColor` so the mark takes the colour of the lockup it sits in — which is
 * also what makes it legible if it is ever placed on a dark ground.
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M7 13c8 0 10 11 17 11s9 11 17 11"
        stroke="currentColor"
        strokeWidth={3.4}
        strokeLinecap="round"
      />
      <path
        d="M7 35c8 0 10-11 17-11s9-11 17-11"
        stroke="var(--color-accent)"
        strokeWidth={3.4}
        strokeLinecap="round"
      />
    </svg>
  )
}
