/**
 * Bump whenever what a tagged text means or how it is hashed changes in packages/content: the
 * placeholder grammar, the tagged-text serialization, the hash input. It is mixed into every
 * block hash so a rule change can never mix old and new cache entries (ADR 0005, 0053). A bump
 * also bumps PIPELINE_VERSION, so every stored body is processed again under it.
 */
export const NORM_VERSION = 1

/**
 * Bump whenever `processArticleHtml` can turn a stored body into something else: sanitizing,
 * normalization, skip rules, excerpts. Every version stores the pipeline it was processed under,
 * and `article.reprocess` processes each article's current version again from its raw HTML when
 * that is older, adding a version only where the result changed (ADR 0055).
 */
export const PIPELINE_VERSION = 1

/** Source tokens translated per article body; the rest renders as source (`partial`). */
export const MAX_ARTICLE_TRANSLATION_TOKENS = 40_000

/** Site listing states. */
export const SITE_LISTINGS = ['private', 'listed', 'featured', 'rejected'] as const
export type SiteListing = (typeof SITE_LISTINGS)[number]

/**
 * What an operator's review decided about a blog for Discover (ADR 0041): `listed` by List,
 * Feature or curation, `dismissed` by Not for Discover, or by a Hide that found nothing decided.
 * Null while nobody has decided. The listing says where the blog is now; this says what the
 * review chose, so a Restore or a removed claim returns a blog an operator listed to listed.
 */
export const SITE_REVIEWS = ['listed', 'dismissed'] as const
export type SiteReview = (typeof SITE_REVIEWS)[number]

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

/**
 * How a claim was proved (ADRs 0011, 0045): a meta tag with the token, a `rel="me"` link to the
 * Tela profile, a plain link to it the blog's 404 page shows too, or a GitHub that links back. `dns` is
 * reserved and never written.
 */
export const CLAIM_METHODS = ['meta', 'rel_me', 'link', 'github', 'dns'] as const
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

/**
 * A folder holds some of a member's subscriptions, private to them (ADR 0048). A name is a label,
 * not a description, and a member who needs more than a hundred folders has made each one a blog.
 */
export const FOLDER_NAME_MAX = 60
export const MAX_FOLDERS = 100

/**
 * A blogroll is a member's list of blogs to share (ADR 0050), each with a note. A name is a title,
 * a description a line or two, a note a sentence about one blog. Two hundred blogs is a long page,
 * not a directory; fifty blogrolls is more than anyone shares.
 */
export const BLOGROLL_NAME_MAX = 60
export const BLOGROLL_DESCRIPTION_MAX = 280
export const BLOGROLL_NOTE_MAX = 280
export const MAX_BLOGROLL_BLOGS = 200
export const MAX_BLOGROLLS = 50
/** A public blogroll reaches Discover once this many of its blogs are shown to others. */
export const BLOGROLL_DISCOVER_MIN = 3

/** Unread horizon: articles older than this never count as unread. */
export const UNREAD_HORIZON_DAYS = 30

/** Where Gravatar serves pictures (ADR 0032); `GRAVATAR_URL` in tela-api and tela-jobs overrides it. */
export const GRAVATAR_URL = 'https://gravatar.com/avatar'
