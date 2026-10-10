/**
 * A post's title on a public page, in the language its reader reads: the translation when the
 * page carries one, badged "JA → EN"; the post's own title, badged with its language, when it
 * does not; and as written, unbadged, in the reader's own language or one they never translate.
 */
import { languageBadge } from '@tela/shared'
import type { PublicArticle, Reading } from '../views/types'

export function publicTitle(
  a: PublicArticle,
  reading: Reading,
): { title: string; badge: string | null } {
  const source = a.sourceLang
  if (!source || source === reading.lang || reading.never.includes(source)) {
    return { title: a.title, badge: null }
  }
  const translated = a.titles?.[reading.lang]
  return translated
    ? { title: translated, badge: `${languageBadge(source)} → ${languageBadge(reading.lang)}` }
    : { title: a.title, badge: languageBadge(source) }
}

/**
 * The excerpt beside `publicTitle`'s title: translated only when the title shows translated, so a
 * language the reader never translates keeps both as written, and a title and its excerpt never
 * show in two languages because one had a translation and the other did not.
 */
export function publicExcerpt(
  a: PublicArticle & { excerpts?: Partial<Record<string, string>> },
  reading: Reading,
): string | null {
  const source = a.sourceLang
  if (!source || source === reading.lang || reading.never.includes(source)) return a.excerpt
  if (!a.titles?.[reading.lang]) return a.excerpt
  return a.excerpts?.[reading.lang] ?? a.excerpt
}
