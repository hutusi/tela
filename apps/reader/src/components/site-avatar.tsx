import { assetUrl } from '../lib/format'
import { Swatch } from './swatch'

/** The site's favicon when stored, otherwise a colored initial. */
export function SiteAvatar({
  id,
  title,
  faviconKey,
  size = 40,
  radius = 10,
  round = false,
  className = '',
}: {
  id: number
  title: string
  faviconKey: string | null
  size?: number
  /** The favicon's corner; an initial's grows with its size. A blog page's 84px one wants 20. */
  radius?: number
  /** A circle, favicon or initial, as the end of an article draws the blog. */
  round?: boolean
  /** Classes for the image or the initial, e.g. `max-md:!size-16` where CSS alone may resize it. */
  className?: string
}) {
  const src = assetUrl(faviconKey)
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className={`shrink-0 bg-surface object-cover ${className}`}
        style={{ width: size, height: size, borderRadius: round ? '50%' : radius }}
      />
    )
  }
  return <Swatch id={id * 7919} title={title} size={size} round={round} className={className} />
}
