import type { ReadingMode } from '@/app/reading/href'
import { readingModeParam } from '@/app/reading/href'

/** Where the browser remembers the reader's display mode. */
export const READING_MODE_COOKIE = 'tela_reading_mode'

export const READING_MODE_COOKIE_MAX_AGE = 365 * 24 * 3600

/**
 * The mode a reader last chose, so closing an article does not forget it.
 *
 * The URL stays authoritative for a view (ADR 0017): this only supplies the default when a URL
 * says nothing, which is every URL with no article open — `readingHref` drops `mode` there,
 * because a display mode for no article means nothing. Without this, someone who reads
 * translation-only re-picked it on every article.
 *
 * Unlike the reading language this is not namespaced by member. That cookie mirrors a `profiles`
 * column and must not leak the previous user's setting into someone else's session; a display
 * mode has no server truth and nothing to leak, so it works like `tela_locale`.
 */
export function readingModeDocumentCookie(mode: ReadingMode): string {
  return `${READING_MODE_COOKIE}=${mode}; Path=/; Max-Age=${READING_MODE_COOKIE_MAX_AGE}; SameSite=Lax`
}

/** The mode a cookie holds, or null when it holds nothing usable. */
export function readingModeFromCookie(value: string | undefined): ReadingMode | null {
  return readingModeParam(value)
}
