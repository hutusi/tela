import { initialOf, swatchColor } from '../lib/format'

/** Colored square with the feed's initial; the same feed always gets the same color. */
export function Swatch({
  id,
  title,
  size = 18,
  round = false,
  color,
}: {
  id: number
  title: string
  size?: number
  round?: boolean
  /** A colour of its own instead of the feed's, for a blog that is not one (For writers' sample). */
  color?: string
}) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center font-semibold text-white"
      style={{
        width: size,
        height: size,
        borderRadius: round ? '50%' : Math.max(3, Math.round(size / 4)),
        background: color ?? swatchColor(id),
        fontSize: Math.max(9, Math.round(size * 0.55)),
      }}
    >
      {initialOf(title)}
    </span>
  )
}
