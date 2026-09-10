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
 * Whether to badge a row as a translation.
 *
 * Exact tags, like every other language comparison in the codebase — `titleEnqueuer`,
 * `translateArticleTitle`, `translateArticleBody`, `reader-data.ts`, the block cache and the
 * discover filter all treat `zh-Hant` and `zh-Hans` as different languages, because they are.
 * Comparing primary subtags here silently converted a Traditional title to Simplified with
 * nothing to say so, while the article pane it opened said "Written in 繁體中文. Translated to
 * 简体中文." — the badge reads ZH-TW → ZH, which is exactly what the reader was missing.
 *
 * Regional variants are not a concern: `normalizeLangTag` collapses every tag to its primary
 * subtag before it is stored, keeping only the two Chinese ones, so `en-GB` never reaches here.
 * A translation must exist for the badge to appear at all, and an undetected source language
 * (stored as NULL) is never claimed as translated.
 */
export function showsTranslationBadge(
  sourceLang: string | null,
  readingLang: string,
  translatedTitle: string | null,
): boolean {
  if (!sourceLang || translatedTitle === null) return false
  return sourceLang !== readingLang
}
