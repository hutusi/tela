import { assetUrl } from '../lib/format'
import { Swatch } from './swatch'

/** The site's favicon when stored, otherwise a colored initial. */
export function SiteAvatar({
  id,
  title,
  faviconKey,
  size = 40,
}: {
  id: number
  title: string
  faviconKey: string | null
  size?: number
}) {
  const src = assetUrl(faviconKey)
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-[10px] bg-white object-cover"
        style={{ width: size, height: size }}
      />
    )
  }
  return <Swatch id={id * 7919} title={title} size={size} />
}
