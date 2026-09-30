import { initialOf, swatchColor } from '../lib/format'

/** Colored square with the feed's initial; the same feed always gets the same color. */
export function Swatch({
  id,
  title,
  size = 18,
  round = false,
}: {
  id: number
  title: string
  size?: number
  round?: boolean
}) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center font-semibold text-white"
      style={{
        width: size,
        height: size,
        borderRadius: round ? '50%' : Math.max(3, Math.round(size / 4)),
        background: swatchColor(id),
        fontSize: Math.max(9, Math.round(size * 0.55)),
      }}
    >
      {initialOf(title)}
    </span>
  )
}
