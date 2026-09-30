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
