/**
 * The v1 API's documented formats (ADR 0065): one zod schema per request and answer, the source of
 * `docs/api/openapi.json`. These are the API's own, deliberately not the web's: the web's routes
 * stay free to change, and a shared function's change reaches an app only through the mappers in
 * `./transform`, where the golden fixtures catch it.
 *
 * Conventions, for every route:
 * - camelCase keys; times are epoch milliseconds; server ids are integers that compare in order;
 *   ids a client mints (highlights, folders, mutation ids) are strings.
 * - An app ignores fields it does not know, and every enum says whether it is open (new values may
 *   appear within v1: treat an unknown one as documented) or closed.
 * - An error is `{ error, … }` (`errorSchema`) with its HTTP status; 401 and 403 also carry
 *   `WWW-Authenticate`, and 429 and 503 carry `Retry-After`.
 *
 * Apps never import this module; the gateway's handlers, the contract suite and the OpenAPI
 * generator do.
 */
import { API_VERSION_STATUSES, APP_SCOPES, BLOGROLL_ID, READING_LANGUAGES } from '@tela/shared'
import { z } from 'zod'
import { API_ERRORS, V1_PREF_KEYS, V1_REJECTIONS, V1_ROW_TYPES, type V1PrefKey } from './transform'

const id = z.number().int().positive()
const time = z.number().int().nonnegative().meta({ description: 'Epoch milliseconds' })
const contentKey = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .meta({ description: 'A content object’s key: 32 hex characters' })
const language = z.enum(READING_LANGUAGES)
const url = z.string()
/** A string a client mints: a mutation, highlight or folder id. */
const clientId = z.string().min(8).max(40)
/** A blogroll's id: twelve letters and digits, minted by its member's device. */
const blogrollId = z.string().regex(BLOGROLL_ID)
/** A highlight's language: the translation's it was made on; null on the original. */
const highlightLang = z.string().max(16).nullable().meta({
  description: 'The translation’s language for a highlight made on one; null on the original',
})

// ———————————————————————————————————————————— errors

/** Every error answer. Open: an app treats an unknown `error` by its HTTP status. */
export const errorSchema = z.looseObject({
  error: z.enum(API_ERRORS).meta({ description: 'Open enum' }),
})

/** 429 `post_limit` / `feed_limit`, and a refused body in a bundle. */
export const limitErrorSchema = z.object({
  error: z.enum(['post_limit', 'feed_limit']),
  limit: z.number().int().nonnegative(),
  resetsAt: time,
})

// ———————————————————————————————————————————— meta, me, usage

export const metaSchema = z.object({
  api: z.literal('tela'),
  current: z.number().int(),
  oldest: z.number().int(),
  versions: z.array(
    z.object({
      version: z.number().int(),
      status: z.enum(API_VERSION_STATUSES).meta({ description: 'Open enum' }),
      sunsetAt: time.nullable(),
    }),
  ),
  /** What each version offers, by name; an app checks for a feature rather than a version. */
  features: z.record(z.string(), z.array(z.string())),
  limits: z.object({
    pushMutations: z.number().int(),
    pushBytes: z.number().int(),
    pageRows: z.number().int(),
    bodiesPerRequest: z.number().int(),
    horizonDays: z.number().int(),
    readingLanguages: z.array(language),
    /** The site's current daily limits; null is none. A member's own state is `/v1/usage`. */
    translationsPerDay: z.number().int().nullable(),
    feedsPerDay: z.number().int().nullable(),
    maxSubscriptions: z.number().int().nullable(),
    unsubscribedPostsPerDay: z.number().int().nullable(),
  }),
  oauth: z.object({ metadata: url }),
})

export const meSchema = z.object({
  handle: z.string(),
  displayName: z.string().nullable(),
  avatar: url.nullable().meta({ description: 'An absolute URL, or null' }),
  readingLanguage: language.nullable(),
  scope: z.enum(APP_SCOPES),
  /** Only when the member let this app see it. */
  email: z.string().optional(),
})

export const usageSchema = z.object({
  translations: z.object({
    perDay: z.number().int().nullable(),
    usedToday: z.number().int(),
    waiting: z.number().int(),
    resetsAt: time,
  }),
  feeds: z.object({
    perDay: z.number().int().nullable(),
    addedToday: z.number().int(),
    pending: z.number().int(),
  }),
  subscriptions: z.object({ max: z.number().int().nullable(), count: z.number().int() }),
  posts: z.object({
    perDay: z.number().int().nullable(),
    openedToday: z.number().int(),
    resetsAt: time,
  }),
  rateLimits: z.object({
    perMemberPerMinute: z.number().int().nullable(),
    perAppPerMinute: z.number().int().nullable(),
  }),
})

// ———————————————————————————————————————————— sync rows

export const profileRowSchema = z.object({
  handle: z.string(),
  displayName: z.string().nullable(),
  bio: z.string().nullable(),
  avatar: url.nullable(),
  readingLanguage: language.nullable(),
  publicSubscriptions: z.boolean(),
  publicLikes: z.boolean(),
})

/**
 * Each pref v1 speaks (`V1_PREF_KEYS`), with its value's type. Others are never sent, and
 * `setPref` takes no other.
 */
export const prefSchemas = {
  'reader.hide_read': z
    .boolean()
    .meta({ description: 'Lists show unread posts only; default true' }),
  'reader.mark_on_open': z.boolean().meta({ description: 'Opening a post reads it; default true' }),
  'translate.auto': z
    .boolean()
    .meta({ description: 'A post in another language is translated as it opens; default true' }),
  'translate.never': z
    .array(z.string().min(2).max(16))
    .max(20)
    .meta({ description: 'Language tags the member reads as written; default none' }),
} satisfies Record<V1PrefKey, z.ZodType>

/** A pref from the documented allowlist. Open: a key an app does not know, it ignores. */
const prefRow = <K extends V1PrefKey>(key: K) =>
  z.object({ key: z.literal(key), value: prefSchemas[key], updatedAt: time })
export const prefRowSchema = z.discriminatedUnion('key', [
  prefRow('reader.hide_read'),
  prefRow('reader.mark_on_open'),
  prefRow('translate.auto'),
  prefRow('translate.never'),
])

export const subscriptionRowSchema = z.object({
  feedId: id,
  /**
   * Every post of the feed with an id at or below this is read, unless its state is
   * `markedUnread` (see `stateRowSchema` for the whole rule).
   */
  watermarkId: z.number().int().nonnegative(),
  createdAt: time,
  /** Set: unsubscribed. The app drops the feed's posts it does not keep. */
  deletedAt: time.nullable(),
})

export const feedRowSchema = z.object({
  id,
  siteId: id,
  feedUrl: url,
  title: z.string().nullable(),
  status: z.string().meta({ description: 'Open enum: active, failing, dead, paused, …' }),
  lastFetchedAt: time.nullable(),
  lastItemAt: time.nullable(),
})

export const siteRowSchema = z.object({
  id,
  homeUrl: url,
  title: z.string().nullable(),
  description: z.string().nullable(),
  faviconUrl: url.nullable(),
  primaryLang: z.string().nullable(),
  readerCount: z.number().int(),
  /** False: the writer said no translation. Discard the site’s titles and translations. */
  translationAllowed: z.boolean(),
  claimed: z.boolean(),
})

export const articleRowSchema = z.object({
  id,
  feedId: id,
  url: url.nullable(),
  title: z.string(),
  author: z.string().nullable(),
  publishedAt: time.nullable(),
  /** When Tela first fetched it: the horizon (`limits.horizonDays`) counts from here. */
  fetchedAt: time,
  /** The order lists sort by. */
  sortAt: time,
  sourceLang: z.string().nullable(),
  excerpt: z.string().nullable(),
  /** Null when Tela holds no body: the app shows the excerpt and links to the post. */
  contentKey: contentKey.nullable(),
  wordCount: z.number().int(),
  readingMinutes: z.number().int(),
  likeCount: z.number().int(),
  recommendCount: z.number().int(),
})

/** A title translated into the cursor's language. Only translations that exist are sent. */
export const titleRowSchema = z.object({
  articleId: id,
  lang: language,
  title: z.string().nullable(),
  excerpt: z.string().nullable(),
})

/**
 * The member's read and like state of a post. A post is read when its state's `readAt` is set;
 * otherwise unread when its state is `markedUnread`; otherwise read when its id is at or below its
 * subscription's `watermarkId`, or it was fetched (`fetchedAt`) more than `limits.horizonDays`
 * ago; otherwise, with no state at all included, unread. A post marked unread by hand is sent even
 * past the horizon, and stays unread until a later read.
 */
export const stateRowSchema = z.object({
  articleId: id,
  readAt: time.nullable(),
  /** True: the member marked it unread by hand, which beats the watermark until a later read. */
  markedUnread: z.boolean(),
  likedAt: time.nullable(),
})

export const recommendationRowSchema = z.object({
  articleId: id,
  note: z.string().nullable(),
  createdAt: time,
  deletedAt: time.nullable(),
})

export const highlightRowSchema = z.object({
  id: clientId,
  articleId: id,
  contentKey,
  side: z.enum(['original', 'translation']),
  lang: highlightLang,
  /** A leaf's `data-tb` id in the body. */
  leafId: z.string(),
  /** UTF-16 code units into the leaf's text. */
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  quote: z.string(),
  prefix: z.string(),
  suffix: z.string(),
  note: z.string().nullable(),
  createdAt: time,
  updatedAt: time,
  deletedAt: time.nullable(),
})

/** A body translation's state, in the cursor's language. */
export const translationRowSchema = z.object({
  contentKey,
  lang: language,
  state: z
    .enum(['waiting', 'requested', 'running', 'done', 'partial', 'failed', 'skipped'])
    .meta({ description: 'Open enum. `waiting`: due at `dueAt`, not before.' }),
  /** Finished chunks while it runs, as content paths (`/o/tc/…`), in order. */
  chunks: z.array(z.string()),
  /** The finished translation's content path (`/o/t/…`), once there is one. */
  object: z.string().nullable(),
  dueAt: time.nullable(),
})

export const folderRowSchema = z.object({
  id: clientId,
  name: z.string(),
  createdAt: time,
  updatedAt: time,
  deletedAt: time.nullable(),
})

export const feedFolderRowSchema = z.object({
  feedId: id,
  folderId: clientId.nullable(),
  updatedAt: time,
})

export const followRowSchema = z.object({
  userId: z.string(),
  handle: z.string(),
  displayName: z.string().nullable(),
  avatar: url.nullable(),
  createdAt: time,
  deletedAt: time.nullable(),
})

export const syncQuerySchema = z.object({
  /** Absent or `0`: a snapshot. Otherwise the `cursor` the last pull answered. */
  cursor: z.string().optional(),
  /** The reading language titles and translations come in. */
  lang: language,
  /**
   * Comma-separated row types; absent is the fourteen v1 began with (`V1_DEFAULT_TYPES`). A type
   * added within v1 comes only to an app that names it.
   */
  types: z.string().optional(),
})

export const syncSchema = z.object({
  /** Send it back on the next pull. Opaque. */
  cursor: z.string(),
  /** The page ended early: pull again now with `cursor`. */
  more: z.boolean(),
  /** A snapshot: drop every row held and take these. */
  reset: z.boolean(),
  lang: language,
  types: z.array(z.enum(V1_ROW_TYPES)),
  rows: z.object({
    profile: profileRowSchema.nullable(),
    prefs: z.array(prefRowSchema),
    subscriptions: z.array(subscriptionRowSchema),
    feeds: z.array(feedRowSchema),
    sites: z.array(siteRowSchema),
    articles: z.array(articleRowSchema),
    titles: z.array(titleRowSchema),
    states: z.array(stateRowSchema),
    recommendations: z.array(recommendationRowSchema),
    highlights: z.array(highlightRowSchema),
    translations: z.array(translationRowSchema),
    folders: z.array(folderRowSchema),
    feedFolders: z.array(feedFolderRowSchema),
    follows: z.array(followRowSchema),
  }),
})

// ———————————————————————————————————————————— mutations

const base = {
  /** Minted by the app, unique per mutation: a replay with the same `mid` changes nothing. */
  mid: clientId,
  /** When the member did it, by the app's clock (clamped to Tela's): the later one wins. */
  at: time,
}

export const mutationSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('markRead'), articleId: id }),
  z.object({ ...base, type: z.literal('markUnread'), articleId: id }),
  z.object({ ...base, type: z.literal('setLiked'), articleId: id, liked: z.boolean() }),
  /** Every post up to `upTo` (the highest id the app showed), in one feed or all. */
  z.object({ ...base, type: z.literal('markAllRead'), feedId: id.optional(), upTo: id }),
  z.object({ ...base, type: z.literal('subscribe'), feedId: id }),
  z.object({ ...base, type: z.literal('unsubscribe'), feedId: id }),
  /** A key from the documented allowlist, with that key's value type (`prefSchemas`). */
  z.object({
    ...base,
    type: z.literal('setPref'),
    key: z.enum(V1_PREF_KEYS),
    value: z.unknown(),
  }),
  /** Null follows the member's interface language. */
  z.object({ ...base, type: z.literal('setReadingLanguage'), language: language.nullable() }),
  z.object({
    ...base,
    type: z.literal('recommend'),
    articleId: id,
    note: z.string().max(500).nullable(),
  }),
  z.object({ ...base, type: z.literal('unrecommend'), articleId: id }),
  z.object({
    ...base,
    type: z.literal('putHighlight'),
    id: clientId,
    articleId: id,
    contentKey,
    side: z.enum(['original', 'translation']),
    lang: highlightLang,
    leafId: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    quote: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    note: z.string().nullable(),
  }),
  z.object({ ...base, type: z.literal('deleteHighlight'), id: clientId }),
  z.object({ ...base, type: z.literal('follow'), userId: z.string() }),
  z.object({ ...base, type: z.literal('unfollow'), userId: z.string() }),
  z.object({ ...base, type: z.literal('putFolder'), id: clientId, name: z.string() }),
  z.object({ ...base, type: z.literal('deleteFolder'), id: clientId }),
  z.object({
    ...base,
    type: z.literal('fileFeed'),
    feedId: id,
    folderId: clientId.nullable(),
  }),
])
export type V1Mutation = z.infer<typeof mutationSchema>

export const pushRequestSchema = z.object({ mutations: z.array(z.unknown()).max(50) })

export const pushSchema = z.object({
  /**
   * One per mutation sent, in order. `applied`: it holds (a replay is `applied` too). `rejected`:
   * it never will; drop it. A pull begun after this answer reflects every applied mutation.
   */
  results: z.array(
    z.object({
      mid: z.string().nullable(),
      status: z.enum(['applied', 'rejected']),
      /** Why it was rejected (`V1_REJECTIONS`). */
      error: z.enum(V1_REJECTIONS).meta({ description: 'Open enum' }).optional(),
    }),
  ),
})

// ———————————————————————————————————————————— content

/** A content object, as stored and immutable: its own `format` says how to read it. */
export const contentObjectSchema = z.looseObject({
  format: z.literal(1),
  norm: z.number().int(),
  key: contentKey,
  lang: z.string(),
  blocks: z.array(z.object({ tag: z.string(), html: z.string(), leaves: z.array(z.string()) })),
  leaves: z.record(z.string(), z.looseObject({ hash: z.string(), chars: z.number().int() })),
  /** Original image URLs, served as `/img/<key>/<index>`. */
  images: z.array(url),
  stats: z.object({ chars: z.number().int(), words: z.number().int(), minutes: z.number().int() }),
})

export const bodiesQuerySchema = z.object({
  /** Comma-separated content keys, at most `limits.bodiesPerRequest`. */
  keys: z.string(),
})

export const bodiesSchema = z.object({
  objects: z.record(z.string(), contentObjectSchema),
  /** Keys refused, and why: today's limit on posts from blogs the member does not follow. */
  refused: z.record(z.string(), limitErrorSchema),
})

/** A finished translation (`/o/t/…`), aligned with the content object's blocks. */
export const translationObjectSchema = z.looseObject({
  format: z.literal(1),
  norm: z.number().int(),
  source: z.string(),
  lang: z.string(),
  status: z.enum(['done', 'partial', 'failed']).meta({ description: 'Open enum' }),
  /** HTML per block; a block with no translation carries its source. */
  blocks: z.array(z.string()),
  failedLeaves: z.array(z.string()),
})

/** A chunk of a translation still running (`/o/tc/…`): block index → HTML. */
export const translationChunkSchema = z.looseObject({
  format: z.literal(1),
  n: z.number().int(),
  blocks: z.record(z.string(), z.string()),
})

// ———————————————————————————————————————————— translations

export const translationRequestSchema = z.object({ articleId: id, lang: language })

export const translationAnswerSchema = z.object({
  /**
   * Open enum. `ready`: done, fetch `translation.object`. `running`: poll the status. `waiting`:
   * the member's or the site's day is full; due at `dueAt`. `refused`: no room today or tomorrow,
   * see `reason` and `resetsAt`. `unavailable`: the writer said no translation, or there is no body.
   */
  status: z.enum(['ready', 'running', 'waiting', 'refused', 'unavailable']),
  translation: translationRowSchema.nullable(),
  reason: z.enum(['member', 'site']).optional(),
  resetsAt: time.optional(),
})

export const translationStatusSchema = z.object({ translation: translationRowSchema.nullable() })

// ———————————————————————————————————————————— feeds

export const discoverFeedsRequestSchema = z.object({ url: url.max(2048) })

export const discoverFeedsSchema = z.object({
  feeds: z.array(
    z.object({
      feedUrl: url,
      title: z.string().nullable(),
      /** Tela already has it: subscribing is free, and adds nothing to the day's count. */
      feedId: id.nullable(),
    }),
  ),
})

export const addFeedRequestSchema = z.object({ url: url.max(2048) })

export const addFeedSchema = z.object({
  feed: feedRowSchema,
  site: siteRowSchema,
  /** True: the feed is new to Tela and counted in the day's feeds. */
  added: z.boolean(),
})

/** `POST /v1/feeds/opml` takes the OPML document itself as the body. */
export const importFeedsSchema = z.object({
  subscribed: z.number().int(),
  added: z.number().int(),
  /** New to Tela, past today's count: added on the next days. */
  waiting: z.number().int(),
  /** Past the subscription cap: never added. */
  over: z.number().int(),
  perDay: z.number().int().nullable(),
  maxSubscriptions: z.number().int().nullable(),
  resetsAt: time,
})

// ———————————————————————————————————————————— the public side

/** A post as public pages list it: never a content key; open it with `/v1/articles/{id}`. */
export const postCardSchema = z.object({
  id,
  siteId: id,
  title: z.string(),
  /** In the asked language (`lang`, else the member's reading language); never for a writer who said no. */
  translatedTitle: z.string().nullable(),
  excerpt: z.string().nullable(),
  url: url.nullable(),
  author: z.string().nullable(),
  publishedAt: time.nullable(),
  likeCount: z.number().int(),
})

export const blogCardSchema = z.object({
  id,
  title: z.string().nullable(),
  homeUrl: url,
  description: z.string().nullable(),
  faviconUrl: url.nullable(),
  primaryLang: z.string().nullable(),
  readerCount: z.number().int(),
  topics: z.array(z.string()),
})

export const readerCardSchema = z.object({
  /** The member's account id: what `follow` and `unfollow` name. It grants nothing on its own. */
  userId: z.string(),
  handle: z.string(),
  displayName: z.string().nullable(),
  avatar: url.nullable(),
})

const page = { page: z.number().int().positive(), more: z.boolean() }

export const publicQuerySchema = z.object({
  page: z.coerce.number().int().positive().max(1000).optional(),
  lang: language.optional(),
  topic: z.string().optional(),
})

export const discoverPostsSchema = z.object({ posts: z.array(postCardSchema), ...page })
export const discoverBlogsSchema = z.object({ blogs: z.array(blogCardSchema), ...page })
export const discoverReadersSchema = z.object({ readers: z.array(readerCardSchema), ...page })
export const discoverBlogrollsSchema = z.object({
  blogrolls: z.array(
    z.object({
      id: blogrollId,
      name: z.string(),
      description: z.string().nullable(),
      owner: readerCardSchema,
      blogCount: z.number().int(),
    }),
  ),
  ...page,
})

export const sitePageSchema = z.object({
  blog: blogCardSchema,
  feeds: z.array(z.object({ id, title: z.string().nullable(), feedUrl: url })),
  posts: z.array(postCardSchema),
  ...page,
})

export const profilePageSchema = z.object({
  reader: readerCardSchema.extend({ bio: z.string().nullable() }),
  recommendations: z.array(
    z.object({ post: postCardSchema, note: z.string().nullable(), createdAt: time }),
  ),
  /** Only when the member shows their likes. */
  likes: z.array(postCardSchema).optional(),
  /** Only when the member shows their subscriptions. */
  subscriptions: z.array(blogCardSchema).optional(),
  ...page,
})

export const blogrollPageSchema = z.object({
  id: blogrollId,
  name: z.string(),
  description: z.string().nullable(),
  owner: readerCardSchema,
  blogs: z.array(z.object({ blog: blogCardSchema, feedId: id, note: z.string().nullable() })),
})

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  page: z.coerce.number().int().positive().max(100).optional(),
  lang: language.optional(),
})

export const searchSchema = z.object({
  posts: z.array(postCardSchema),
  blogs: z.array(blogCardSchema),
  ...page,
})

/** A post opened from a public page: held like a synced one, its body from `/v1/bodies`. */
export const articlePageSchema = z.object({
  article: articleRowSchema,
  feed: feedRowSchema,
  site: siteRowSchema,
})
