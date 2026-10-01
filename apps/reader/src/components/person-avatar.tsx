/**
 * A member's picture over their initial, in a circle of their colour (ADR 0031). The picture is
 * their Gravatar, served from Tela (ADR 0032), and the address is the server's: this renders it,
 * never builds one. The initial always renders, under the picture, which covers it only once it
 * has loaded: a slow, failed or offline load, or no picture at all, leaves the initial. The
 * member's own is on the accent, as the header's always was.
 */
import { useState } from 'react'
import { initialOf, personColor } from '../lib/format'

/** Only the address tela-api names: anything else in a cached public answer is not rendered. */
const AVATAR_PATH = /^\/avatar\/[A-Za-z0-9_-]{8,64}\?v=\d{1,16}$/

export function PersonAvatar({
  handle,
  displayName,
  avatar = null,
  size,
  me = false,
  className = '',
}: {
  handle: string
  displayName: string | null
  avatar?: string | null | undefined
  size: number
  me?: boolean
  className?: string
}) {
  // Which address failed or loaded: a new one (Refresh, another person) starts over.
  const [failed, setFailed] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<string | null>(null)
  const src = avatar && AVATAR_PATH.test(avatar) && failed !== avatar ? avatar : null
  return (
    <span
      aria-hidden="true"
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-serif font-semibold text-white ${me ? 'bg-accent' : ''} ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        ...(me ? {} : { background: personColor(handle) }),
      }}
      data-avatar={src ? 'picture' : 'initial'}
    >
      {initialOf(displayName ?? handle)}
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(src)}
          onError={() => setFailed(src)}
          className={`absolute inset-0 size-full rounded-full object-cover ${loaded === src ? 'bg-surface' : ''}`}
        />
      ) : null}
    </span>
  )
}
