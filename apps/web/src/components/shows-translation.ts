/**
 * Which title to render for a post. A translation we hold is always the one to show.
 *
 * This asks nothing about the language pair on purpose — that is the badge's question, and
 * answering both with one predicate is a bug that has been written twice now. Search matches
 * `translated_title` in SQL, so a hit whose translation is hidden renders with none of the text
 * the reader typed; the reading list has the milder version of the same problem.
 */
export function displayTitle(title: string, translatedTitle: string | null): string {
  return translatedTitle ?? title
}

/**
 * Whether to badge a row as a cross-language translation.
 *
 * Deliberately narrower than `displayTitle`. It requires a translation to actually exist — the
 * badge reads "EN → ZH" and must never hang over an untouched original — and it compares primary
 * subtags, so the translations we hold but should stay quiet about (zh-Hant rendered into
 * zh-Hans, en-GB into en) are shown without a badge that would read "ZH → ZH". An article whose
 * source language was never detected is never claimed as translated either.
 */
export function showsTranslationBadge(
  sourceLang: string | null,
  readingLang: string,
  translatedTitle: string | null,
): boolean {
  if (!sourceLang || translatedTitle === null) return false
  return sourceLang.split('-')[0] !== readingLang.split('-')[0]
}
