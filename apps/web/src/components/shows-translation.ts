/**
 * Whether a list row may present itself as translated: the post is in another language *and*
 * we actually hold a translated title for it.
 *
 * Both halves matter. The badge reads "EN → ZH", so it must not appear over an untouched
 * original — and a title job that fails writes no article_translations row at all, silently, so
 * "foreign" alone was not evidence that anything had been translated.
 */
export function showsTranslation(
  sourceLang: string | null,
  readingLang: string,
  translatedTitle: string | null,
): boolean {
  if (!sourceLang || translatedTitle === null) return false
  return sourceLang.split('-')[0] !== readingLang.split('-')[0]
}
