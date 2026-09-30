/**
 * A member's initial in a circle of their colour (no uploaded photos, ADR 0031). The member's own
 * avatar is on the accent, as the header's always was.
 */
import { initialOf, personColor } from '../lib/format'

export function PersonAvatar({
  handle,
  displayName,
  size,
  me = false,
  className = '',
}: {
  handle: string
  displayName: string | null
  size: number
  me?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full font-serif font-semibold text-white ${me ? 'bg-accent' : ''} ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        ...(me ? {} : { background: personColor(handle) }),
      }}
    >
      {initialOf(displayName ?? handle)}
    </span>
  )
}
