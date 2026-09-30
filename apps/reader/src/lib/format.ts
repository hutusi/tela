/** Short relative time such as "2h ago" / "2 小时前", or a date beyond 30 days. */
export function relativeTime(at: number | null, locale: string, now = Date.now()): string {
  if (at === null) return ''
  const diffSec = Math.round((now - at) / 1000)
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
  }).format(new Date(at))
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

/** Hostname for display: no scheme, no www. */
export function displayHost(input: string): string {
  try {
    return new URL(input).hostname.replace(/^www\./, '')
  } catch {
    return input
  }
}

/** The public bucket favicons are served from (the jobs Worker fills it). */
const ASSETS_BASE = (import.meta.env?.VITE_ASSETS_URL ?? 'https://assets.tela.ainaive.com').replace(
  /\/+$/,
  '',
)

/** Public URL for a stored asset key (favicons), or null without one. */
export function assetUrl(key: string | null | undefined): string | null {
  return key ? `${ASSETS_BASE}/${key}` : null
}

/** Posting cadence label key from posts in the last 30 days. */
export function cadenceKey(
  postsLast30d: number,
): 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quiet' {
  if (postsLast30d >= 20) return 'daily'
  if (postsLast30d >= 4) return 'weekly'
  if (postsLast30d >= 2) return 'biweekly'
  if (postsLast30d >= 1) return 'monthly'
  return 'quiet'
}
