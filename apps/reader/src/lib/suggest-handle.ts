/**
 * A handle to offer a writer as they type (For writers): their first name, folded to what a
 * handle may hold, or for a name with nothing Latin in it (a CJK name), their blog's own name.
 * Only a suggestion: tela-api says whether it is free, and the member can change it in Settings.
 */
import { HANDLE, isValidHandle } from '@tela/shared'

/** Letters NFKD leaves whole, spelled as a handle would. */
const SPELLED: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
}

/** "José Ñúñez" → "jose nunez": marks taken off, lower case. */
export function foldName(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (c) => SPELLED[c] ?? c)
}

/** What of `text` a handle may hold, at most 30 characters, with no `_` at either end. */
function handleOf(text: string): string {
  return text
    .replace(/[^a-z0-9_]+/g, '')
    .slice(0, 30)
    .replace(/^_+|_+$/g, '')
}

/** A blog's address as typed (`yourblog.com`, or with its scheme), as a URL to claim. */
export function blogUrl(typed: string): string {
  const text = typed.trim()
  if (!text) return ''
  return /^https?:\/\//i.test(text) ? text : `https://${text}`
}

/** The blog's host, for the card: no scheme, no `www.`, no path. */
export function blogHost(typed: string): string {
  const url = blogUrl(typed)
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return typed.trim()
  }
}

/** Labels that name the kind of host, not whose it is. */
const GENERIC = new Set(['www', 'blog', 'blogs', 'm', 'en', 'zh', 'cn', 'tw', 'hk', 'fr'])

/** The blog's own name, from its host: `blog.hutusi.com` → `hutusi`, `jvns.ca` → `jvns`. */
function hostLabel(typed: string): string {
  const labels = blogHost(typed).toLowerCase().split('.').filter(Boolean)
  // The last label is the top-level domain, unless it is all there is.
  const named = (labels.length > 1 ? labels.slice(0, -1) : labels).filter((l) => !GENERIC.has(l))
  return handleOf((named[0] ?? '').replace(/-/g, '_'))
}

/**
 * The handle to suggest for a name and a blog, or null when neither gives one: the first name
 * ("Ada Lovelace" → `ada`), the whole name when the first is too short ("Li Wei" → `li_wei`), or
 * else the blog's name. A reserved handle (`/@about` is a page) is never suggested.
 */
export function suggestHandle(name: string, blog: string): string | null {
  const words = foldName(name)
    .split(/\s+/)
    .map((w) => handleOf(w.replace(/-/g, '')))
    .filter(Boolean)
  const candidates = [words[0] ?? '', handleOf(words.join('_')), hostLabel(blog)]
  return candidates.find((c) => HANDLE.test(c) && isValidHandle(c)) ?? null
}
