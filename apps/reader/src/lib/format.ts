import { languageBadge } from '@tela/shared'
import { daysAgo } from './days'

/**
 * Formatters by locale and options. Building one costs far more than formatting with it, and a
 * list renders a date per row on every render: one per locale and use is enough.
 */
const formatters = new Map<string, Intl.RelativeTimeFormat | Intl.DateTimeFormat>()

/**
 * One `Intl.RelativeTimeFormat` per locale and style, made once: building one costs far more than
 * using it, and a list words a time per row.
 */
export function relativeFormat(locale: string, style: 'long' | 'short' | 'narrow' = 'long') {
  const key = `r|${style}|${locale}`
  let f = formatters.get(key) as Intl.RelativeTimeFormat | undefined
  if (!f) {
    f = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style })
    formatters.set(key, f)
  }
  return f
}

function dateFormat(locale: string, use: string, options: Intl.DateTimeFormatOptions) {
  const key = `d|${use}|${locale}`
  let f = formatters.get(key) as Intl.DateTimeFormat | undefined
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options)
    formatters.set(key, f)
  }
  return f
}

/**
 * Short relative time such as "2h ago" / "2 小时前" / "il y a 2 h", or a date beyond 30 days.
 * French takes the short style: its narrow one is a bare signed number ("-2 h").
 */
export function relativeTime(at: number | null, locale: string, now = Date.now()): string {
  if (at === null) return ''
  const diffSec = Math.round((now - at) / 1000)
  const style = locale === 'fr' ? 'short' : 'narrow'
  const rtf = relativeFormat(locale, style)
  const abs = Math.abs(diffSec)
  if (abs < 60) return rtf.format(0, 'minute').replace(/^in |^now$/, (m) => (m === 'now' ? m : ''))
  if (abs < 3600) return rtf.format(-Math.round(diffSec / 60), 'minute')
  if (abs < 86400) return rtf.format(-Math.round(diffSec / 3600), 'hour')
  if (abs < 30 * 86400) return rtf.format(-Math.round(diffSec / 86400), 'day')
  return dateFormat(locale, 'ymd', { year: 'numeric', month: 'short', day: 'numeric' }).format(
    new Date(at),
  )
}

/** Deterministic accent color for a feed, from its id. */
export function swatchColor(id: number): string {
  const hue = (id * 137.508) % 360
  return `oklch(0.55 0.11 ${hue.toFixed(1)})`
}

/**
 * A language where a short name has room for a word: the admin console's Translation area, which
 * lists what each post was translated into. Each Chinese in its own script and told apart (简体,
 * 繁體: "中文" alone stopped saying which once Traditional came), the others their badge in
 * capitals. Anything else falls back to the badge ("JA"), which is what the article list calls it
 * too.
 */
const PILL_LABELS: Record<string, string> = {
  'zh-Hans': '简体',
  'zh-Hant': '繁體',
  en: 'EN',
  fr: 'FR',
}
export function pillLabel(tag: string): string {
  return PILL_LABELS[tag] ?? languageBadge(tag)
}

/**
 * A language inside the header's 34px language circle (ADR 0040), which holds one Chinese
 * character or two Latin letters: 简, 繁, EN, FR. A lone 简 or 繁 would say too little as a label
 * on its own, and 简中, 繁中 are game-localization slang; but the circle is not where a reader
 * learns which language it is. It is the theme menu's size, and like it a glyph for the current
 * choice: its accessible name says the whole name ("Language: 简体中文"), and the menu it opens
 * names all four in full, each in its own script. Anything else falls back to the badge ("JA").
 */
const CIRCLE_LABELS: Record<string, string> = {
  'zh-Hans': '简',
  'zh-Hant': '繁',
  en: 'EN',
  fr: 'FR',
}
export function circleLabel(tag: string): string {
  return CIRCLE_LABELS[tag] ?? languageBadge(tag)
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

/**
 * A blog's address for display, from its home: the host without `www.`, and for a blog by path
 * the path too (`world.hey.com/dhh`, `anthropic.com/research`), so two blogs on one host are told
 * apart (ADR 0069). For a feed's or a post's address, `displayHost`.
 */
export function blogAddress(homeUrl: string): string {
  try {
    const url = new URL(homeUrl)
    return url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/+$/, '')
  } catch {
    return homeUrl
  }
}

/** The public bucket favicons are served from (the jobs Worker fills it). */
const ASSETS_BASE = (import.meta.env?.VITE_ASSETS_URL ?? 'https://assets.telaread.com').replace(
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

/** Deterministic colour for a member, from their handle: the same on every page that names them. */
export function personColor(handle: string): string {
  let hash = 0
  for (const ch of handle) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return `oklch(0.55 0.11 ${(hash % 360).toFixed(1)})`
}

/**
 * A day as a list's date column shows it: "Today", "Yesterday", "Sep 27", or with the year once
 * it is not this one. Local days, as the reader lives them. The edge renders one cached page for
 * everyone, in UTC, and the app redraws it on boot in the reader's own: a day apart only for a post
 * within their offset of midnight, which is cheaper than an edge cache split by timezone.
 */
export function shortDate(at: number, locale: string, now = Date.now()): string {
  // The calendar count every "today" in the app is worded from: a date ahead of `now` is today.
  const days = daysAgo(at, now)
  if (days === 0 || days === 1) {
    const word = relativeFormat(locale, 'long').format(-days, 'day')
    return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1)
  }
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  const format = sameYear
    ? dateFormat(locale, 'md', { month: 'short', day: 'numeric' })
    : dateFormat(locale, 'ymd', { year: 'numeric', month: 'short', day: 'numeric' })
  return format.format(new Date(at))
}

/** "September 2026", "2026年9月": when a member joined. */
export function monthYear(at: number, locale: string): string {
  return dateFormat(locale, 'my', { month: 'long', year: 'numeric' }).format(new Date(at))
}
