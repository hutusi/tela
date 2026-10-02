/**
 * Bump whenever the block normalization, placeholder grammar, or hashing rules in
 * packages/content change. It is mixed into every block hash so a rule change can
 * never mix old and new cache entries in the translations table.
 */
export const NORM_VERSION = 1

/** Source tokens translated per article body; the rest renders as source (`partial`). */
export const MAX_ARTICLE_TRANSLATION_TOKENS = 40_000

/**
 * Source tokens one member may have translated on demand per UTC day, about ten articles at
 * the per-article ceiling. Reserved when a request is made, reconciled against recorded usage
 * when the attempt concludes. Background (title) work is budgeted separately by the worker.
 */
export const USER_DAILY_TRANSLATION_TOKENS = 400_000

/** Site listing states. */
export const SITE_LISTINGS = ['private', 'listed', 'featured', 'rejected'] as const
export type SiteListing = (typeof SITE_LISTINGS)[number]

/**
 * Distinct subscribers that list a site in Discover without anyone claiming it. Three, not one:
 * at one, "a site somebody subscribed to" is one member's reading list, published. Three makes
 * the signal an aggregate nobody can read backwards, and costs nothing while the beta is small
 * because nothing reaches it. Promotion is one-way; `rejected` is the veto (ADR 0018).
 */
export const COMMUNITY_LISTING_MIN_READERS = 3

export const FEED_FORMATS = ['rss', 'atom', 'rdf', 'json'] as const
export type FeedFormat = (typeof FEED_FORMATS)[number]

export const FEED_STATUSES = ['active', 'paused', 'dead'] as const
export type FeedStatus = (typeof FEED_STATUSES)[number]

export const FETCH_REGIONS = ['global', 'cn'] as const
export type FetchRegion = (typeof FETCH_REGIONS)[number]

/** WebSub subscription state for a feed that advertises a hub. */
export const WEBSUB_STATUSES = ['pending', 'active', 'failed'] as const
export type WebsubStatus = (typeof WEBSUB_STATUSES)[number]

export const CONTENT_MODES = ['unknown', 'full', 'summary'] as const
export type ContentMode = (typeof CONTENT_MODES)[number]

export const EXTRACTED_FROM = ['feed', 'readability'] as const
export type ExtractedFrom = (typeof EXTRACTED_FROM)[number]

/** pending: only title/excerpt exist; requested/running: body in flight; done/partial/failed: body outcome. */
export const TRANSLATION_STATUSES = [
  'pending',
  'requested',
  'running',
  'done',
  'partial',
  'failed',
] as const
export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number]

export const CLAIM_METHODS = ['meta', 'rel_me', 'dns'] as const
export type ClaimMethod = (typeof CLAIM_METHODS)[number]

export const CLAIM_STATUSES = ['pending', 'verified', 'failed'] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

/** Max length of a recommendation note, enforced in app code and by a DB check. */
export const RECOMMENDATION_NOTE_MAX = 500

/** A highlight is a passage, not a page: past this it is a copy of the post (ADR 0026). */
export const HIGHLIGHT_QUOTE_MAX = 2000
/** Context kept either side of a highlight, to find it again in a changed post. */
export const HIGHLIGHT_CONTEXT = 32
export const HIGHLIGHT_NOTE_MAX = 2000

/** Unread horizon: articles older than this never count as unread. */
export const UNREAD_HORIZON_DAYS = 30

/** Where Gravatar serves pictures (ADR 0032); `GRAVATAR_URL` in tela-api and tela-jobs overrides it. */
export const GRAVATAR_URL = 'https://gravatar.com/avatar'
