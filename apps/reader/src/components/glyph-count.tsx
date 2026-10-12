import { useTranslations } from 'use-intl'
import { Glyph, HEART, PASS } from './glyph'

const SHAPES = { likeCount: HEART, recommendCount: PASS } as const

/**
 * A post's likes or recommendations in a meta line: the drawn heart or arrow and the number. The
 * glyph is hidden from screen readers, so the number alone would be read bare ("5 min 3 1"); it
 * is said in words instead ("3 likes"), and the digits are hidden in their place.
 */
export function GlyphCount({
  kind,
  n,
  className = '',
}: {
  kind: keyof typeof SHAPES
  n: number
  /** E.g. `max-md:hidden`, where a page the edge renders leaves it out on a phone. */
  className?: string
}) {
  const t = useTranslations('common')
  return (
    <span className={`flex items-center gap-1 ${className}`}>
      <Glyph size={12} className="shrink-0">
        {SHAPES[kind]}
      </Glyph>
      <span aria-hidden="true">{n}</span>
      <span className="sr-only">{t(kind, { n })}</span>
    </span>
  )
}
