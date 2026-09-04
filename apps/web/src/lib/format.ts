/** Short relative time such as "2h ago" / "2 小时前", or a date beyond 30 days. */
export function relativeTime(date: Date | null, locale: string, now = new Date()): string {
  if (!date) return ''
  const diffSec = Math.round((now.getTime() - date.getTime()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' })
  const abs = Math.abs(diffSec)
  if (abs < 60) return rtf.format(0, 'minute').replace(/^in |^now$/, (m) => (m === 'now' ? m : ''))
  if (abs < 3600) return rtf.format(-Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(-Math.round(diffSec / 3600), 'hour')
  if (abs < 30 * 86400) return rtf.format(-Math.round(diffSec / 86400), 'day')
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

/** Deterministic accent color for a feed, from its id. */
export function swatchColor(id: number): string {
  const hue = (id * 137.508) % 360
  return `oklch(0.55 0.11 ${hue.toFixed(1)})`
}

export function initialOf(title: string): string {
  const first = [...title.trim()][0] ?? '?'
  return first.toUpperCase()
}
