/** Value lists that exist only in the new data model (the rest come from @tela/shared). */

/** Where an article's full text stands. `due` is what the extraction sweep looks for. */
export const EXTRACT_STATES = ['none', 'due', 'done', 'failed'] as const
export type ExtractState = (typeof EXTRACT_STATES)[number]

/** Where a version of an article's body came from. */
export const PROVENANCES = ['feed', 'readability'] as const
export type Provenance = (typeof PROVENANCES)[number]

/** A body translation, per content version and language. `requested` is what the sweep claims. */
export const BODY_TRANSLATION_STATES = [
  'requested',
  'running',
  'done',
  'partial',
  'failed',
  'skipped',
] as const
export type BodyTranslationState = (typeof BODY_TRANSLATION_STATES)[number]

/**
 * A title translation's outcome. `echo` and `failed` are recorded so the title sweep stops
 * retrying them; an echo is still never written to the shared block cache (AGENTS.md).
 */
export const TITLE_STATUSES = ['done', 'echo', 'failed'] as const
export type TitleStatus = (typeof TITLE_STATUSES)[number]

export const HIGHLIGHT_SIDES = ['original', 'translation'] as const
export type HighlightSide = (typeof HIGHLIGHT_SIDES)[number]

/** Every kind of background work, each claimed through the one lease primitive (ADR 0021). */
export const LEASE_KINDS = [
  'feed.fetch',
  'article.extract',
  'translate.title',
  'translate.body',
  'site.assets',
  'site.claim',
  'websub.subscribe',
] as const
export type LeaseKind = (typeof LEASE_KINDS)[number]
