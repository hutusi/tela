/**
 * The v1 API's pure parts with no zod (ADR 0065), so an edge can import them: the error codes, the
 * row types sync speaks, the opaque cursor, and the mappers from the shared functions' results to
 * each route's format. A mapper names every field it sends, never spreads a row: a column the web
 * adds to a shared result reaches no app until a mapper here says so, and the golden fixtures
 * (`docs/api/v1/examples`) fail when a shared function moves one.
 */
import { READING_LANGUAGES, type ReadingLanguage } from '@tela/shared'

/**
 * Every `error` an API answer may carry. Open: an app treats a code it does not know by its HTTP
 * status (a 4xx it cannot fix, a 429 or 503 to retry after `Retry-After`).
 */
export const API_ERRORS = [
  // 400. A cursor Tela did not make is no error: the pull starts over with a snapshot.
  'invalid_request',
  // 401: the token is missing, unknown, expired or ended (RFC 6750).
  'invalid_token',
  // 403: the token's scope does not cover this (RFC 6750); or the operator cut the app off for
  // now. Keep the tokens: they work again once Tela restores it.
  'insufficient_scope',
  'app_suspended',
  // 404, 413
  'not_found',
  'too_large',
  // 400, 422: a feed address that is not one, or a feed Tela could not reach, read or hold.
  'invalid_url',
  'unreachable',
  'not_a_feed',
  'feed_too_large',
  'opml_invalid',
  // 409
  'subscription_limit',
  // 429: retry after `Retry-After`.
  'rate_limited',
  'feed_limit',
  'post_limit',
  // 503: retry after `Retry-After`.
  'apps_paused',
  'unavailable',
] as const
export type ApiError = (typeof API_ERRORS)[number]

/**
 * Why `POST /v1/mutations` refused a mutation. Open: an app drops a refused mutation whatever its
 * code, and shows the member what it can.
 *
 * - `invalid`: it never will hold, as sent (a shape v1 does not take, a value out of range).
 * - `subscription_limit`: a subscribe past the member's cap.
 */
export const V1_REJECTIONS = ['invalid', 'subscription_limit'] as const
export type V1Rejection = (typeof V1_REJECTIONS)[number]

/**
 * A refusal as v1 words it: the web's push has codes of its own (`invalid_name`, `invalid_range`,
 * …), free to change with the web, and every one of them is `invalid` to an app.
 */
export const v1Rejection = (code: string): V1Rejection =>
  (V1_REJECTIONS as readonly string[]).includes(code) ? (code as V1Rejection) : 'invalid'

/**
 * The row types v1 sync speaks, in the order a snapshot lists them. Adding one is additive: an app
 * asks for it by name, and a cursor that did not cover it gets `reset`.
 */
export const V1_ROW_TYPES = [
  'profile',
  'prefs',
  'subscriptions',
  'feeds',
  'sites',
  'articles',
  'titles',
  'states',
  'recommendations',
  'highlights',
  'translations',
  'folders',
  'feedFolders',
  'follows',
] as const
export type V1RowType = (typeof V1_ROW_TYPES)[number]

/**
 * The row types a pull that names none covers: the fourteen v1 began with, frozen. A type added
 * to `V1_ROW_TYPES` later reaches only an app that asks for it by name, so a cursor made without
 * `types` keeps covering what the default covers, and no app starts over because v1 grew.
 */
export const V1_DEFAULT_TYPES: readonly V1RowType[] = [
  'profile',
  'prefs',
  'subscriptions',
  'feeds',
  'sites',
  'articles',
  'titles',
  'states',
  'recommendations',
  'highlights',
  'translations',
  'folders',
  'feedFolders',
  'follows',
]

/**
 * The row types a pull asked for (`types=`, comma-separated), in the order v1 lists them; the
 * default ones when it names none; null for a name v1 does not know. `known` is v1's list, a
 * parameter so a test can grow it.
 */
export function askedTypes(
  text: string | undefined,
  known: readonly V1RowType[] = V1_ROW_TYPES,
): V1RowType[] | null {
  if (text === undefined || text === '') return [...V1_DEFAULT_TYPES]
  const names = text.split(',').map((t) => t.trim())
  if (!names.every((n) => (known as readonly string[]).includes(n))) return null
  return known.filter((t) => names.includes(t))
}

/** What a v1 cursor holds. Opaque to apps: they send back what they were given. */
export type V1Cursor = {
  /** The sync sequence the app has every row up to. */
  seq: number
  /** The one reading language its titles and translations are in. */
  lang: ReadingLanguage
  /** The row types it holds whole up to `seq`. */
  types: V1RowType[]
}

const CURSOR_VERSION = 1

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function unbase64url(text: string): string | null {
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}

export function encodeCursor(cursor: V1Cursor): string {
  return base64url(
    JSON.stringify({ v: CURSOR_VERSION, s: cursor.seq, l: cursor.lang, t: cursor.types }),
  )
}

/** The cursor an app sent, or null when it is not one Tela made (the app starts with a snapshot). */
export function decodeCursor(text: string): V1Cursor | null {
  if (text.length === 0 || text.length > 512) return null
  const json = unbase64url(text)
  if (json === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { v, s, l, t } = raw as Record<string, unknown>
  if (v !== CURSOR_VERSION) return null
  if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < 0) return null
  if (typeof l !== 'string' || !(READING_LANGUAGES as readonly string[]).includes(l)) return null
  if (!Array.isArray(t) || !t.every((x) => (V1_ROW_TYPES as readonly unknown[]).includes(x)))
    return null
  return { seq: s, lang: l as ReadingLanguage, types: [...new Set(t as V1RowType[])] }
}

/**
 * Whether a pull with this cursor must start over: the app asked for another language, or for a
 * row type the cursor does not hold whole.
 */
export function cursorNeedsReset(
  cursor: V1Cursor | null,
  lang: ReadingLanguage,
  types: readonly V1RowType[],
): boolean {
  if (cursor === null || cursor.seq === 0) return true
  if (cursor.lang !== lang) return true
  return types.some((type) => !cursor.types.includes(type))
}

// ———————————————————————————————————————————— mappers

/**
 * What the mappers need to make a URL absolute: an app is not a page on telaread.com, so no path
 * it is given may be relative to one.
 */
export type V1Context = {
  /** The reader's origin, where a member's picture is (`/avatar/…`). */
  publicUrl: string
  /** tela-assets' public base, where a blog's favicon is (`<base>/<faviconKey>`). */
  assetsUrl: string
}

/** A path Tela gives out, made absolute on `base`; one already absolute, or none, as it is. */
export function absoluteUrl(base: string, path: string | null | undefined): string | null {
  if (!path) return null
  if (/^https?:\/\//.test(path)) return path
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
}

/** A stored object's key as the content path an app fetches it at: `/o/<key>`. */
export const contentPath = (objectKey: string) => `/o/${objectKey}`

/** A reading language, or null for any other value. */
export const readingLanguage = (value: unknown): ReadingLanguage | null =>
  typeof value === 'string' && (READING_LANGUAGES as readonly string[]).includes(value)
    ? (value as ReadingLanguage)
    : null

/**
 * The prefs v1 sync sends and `setPref` takes: how the member reads, never how a screen looks
 * (sizes, themes and the reading mode are each app's own). Each key's value is held to its schema
 * (`prefSchemas` in `./schema`); a stored row whose value does not fit is left out.
 *
 * - `reader.hide_read`: lists show unread posts only (default true).
 * - `reader.mark_on_open`: opening a post reads it (default true).
 * - `translate.auto`: a post in another language asks for its translation as it opens (default
 *   true).
 * - `translate.never`: language tags the member reads as written, never translated (default none).
 */
export const V1_PREF_KEYS = [
  'reader.hide_read',
  'reader.mark_on_open',
  'translate.auto',
  'translate.never',
] as const
export type V1PrefKey = (typeof V1_PREF_KEYS)[number]

export const isV1PrefKey = (key: unknown): key is V1PrefKey =>
  (V1_PREF_KEYS as readonly unknown[]).includes(key)

type Raw = Record<string, unknown>
const num = (v: unknown) => Number(v ?? 0)
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const str = (v: unknown) => String(v ?? '')
const strOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v))

/** The member's own profile row: its public part, and the reading language. */
export const v1Profile = (
  row: {
    handle: string
    displayName: string | null
    bio: string | null
    avatar: string | null
    readingLang: string | null
    publicSubscriptions: boolean
    publicLikes: boolean
  },
  ctx: V1Context,
) => ({
  handle: row.handle,
  displayName: row.displayName,
  bio: row.bio,
  avatar: absoluteUrl(ctx.publicUrl, row.avatar),
  readingLanguage: readingLanguage(row.readingLang),
  publicSubscriptions: row.publicSubscriptions,
  publicLikes: row.publicLikes,
})

export const v1Pref = (row: { key: string; value: unknown; updatedAt: number }) => ({
  key: row.key,
  value: row.value,
  updatedAt: row.updatedAt,
})

export const v1Subscription = (row: {
  feedId: number
  watermarkId: number
  createdAt: number
  deletedAt: number | null
}) => ({
  feedId: row.feedId,
  watermarkId: row.watermarkId,
  createdAt: row.createdAt,
  deletedAt: row.deletedAt,
})

export const v1Feed = (row: {
  id: number
  siteId: number
  feedUrl: string
  title: string | null
  status: string
  lastFetchedAt: number | null
  lastItemAt?: number | null | undefined
}) => ({
  id: row.id,
  siteId: row.siteId,
  feedUrl: row.feedUrl,
  title: row.title,
  status: row.status,
  lastFetchedAt: row.lastFetchedAt,
  lastItemAt: row.lastItemAt ?? null,
})

export const v1Site = (
  row: {
    id: number
    homeUrl: string
    title: string | null
    description: string | null
    faviconKey: string | null
    primaryLang: string | null
    readerCount: number | null
    translationOptOut: boolean
    claimed: boolean
  },
  ctx: V1Context,
) => ({
  id: row.id,
  homeUrl: row.homeUrl,
  title: row.title,
  description: row.description,
  faviconUrl: absoluteUrl(ctx.assetsUrl, row.faviconKey),
  primaryLang: row.primaryLang,
  readerCount: row.readerCount ?? 0,
  translationAllowed: !row.translationOptOut,
  claimed: row.claimed,
})

export const v1Article = (row: {
  id: number
  feedId: number
  url: string | null
  title: string
  author: string | null
  publishedAt: number | null
  fetchedAt: number
  sortAt: number
  sourceLang: string | null
  excerpt: string | null
  contentKey: string | null
  wordCount: number
  readingMinutes: number
  likeCount: number
  recommendCount: number
}) => ({
  id: row.id,
  feedId: row.feedId,
  url: row.url,
  title: row.title,
  author: row.author,
  publishedAt: row.publishedAt,
  fetchedAt: row.fetchedAt,
  sortAt: row.sortAt,
  sourceLang: row.sourceLang,
  excerpt: row.excerpt,
  contentKey: row.contentKey,
  wordCount: row.wordCount,
  readingMinutes: row.readingMinutes,
  likeCount: row.likeCount,
  recommendCount: row.recommendCount,
})

/** A title row, or null for one with nothing translated in it: only translations that exist go. */
export function v1Title(row: {
  articleId: number
  lang: string
  title: string | null
  excerpt: string | null
}) {
  const lang = readingLanguage(row.lang)
  if (lang === null || (row.title === null && row.excerpt === null)) return null
  return { articleId: row.articleId, lang, title: row.title, excerpt: row.excerpt }
}

/**
 * A state row. Marked unread by hand is no read time and a read clock (ADR 0009): every read or
 * like that reads a post sets `readAt`, so a state with none and a clock is the member's choice.
 */
export const v1State = (row: {
  articleId: number
  readAt: number | null
  readUpdatedAt?: number | null | undefined
  likedAt: number | null
}) => ({
  articleId: row.articleId,
  readAt: row.readAt,
  markedUnread: row.readAt === null && row.readUpdatedAt != null,
  likedAt: row.likedAt,
})

export const v1Recommendation = (row: {
  articleId: number
  note: string | null
  createdAt: number
  deletedAt: number | null
}) => ({
  articleId: row.articleId,
  note: row.note,
  createdAt: row.createdAt,
  deletedAt: row.deletedAt,
})

export const v1Highlight = (row: {
  id: string
  articleId: number
  contentKey: string
  side: 'original' | 'translation'
  lang: string | null
  leafId: string
  start: number
  end: number
  quote: string
  prefix: string
  suffix: string
  note: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}) => ({
  id: row.id,
  articleId: row.articleId,
  contentKey: row.contentKey,
  side: row.side,
  lang: row.lang,
  leafId: row.leafId,
  start: row.start,
  end: row.end,
  quote: row.quote,
  prefix: row.prefix,
  suffix: row.suffix,
  note: row.note,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt,
})

/** The states a body translation row may have in v1: the stored ones, and `waiting` before them. */
export type V1TranslationState =
  | 'waiting'
  | 'requested'
  | 'running'
  | 'done'
  | 'partial'
  | 'failed'
  | 'skipped'

/**
 * A body translation row in a reading language, its objects as content paths. A request put off
 * to the next UTC day (ADR 0057) is `waiting` until its `dueAt`. Null for a row in no reading
 * language.
 */
export function v1Translation(
  row: {
    contentKey: string
    lang: string
    state: string
    chunkKeys: string[]
    objectKey: string | null
    dueAt?: number | null | undefined
  },
  now: number,
) {
  const lang = readingLanguage(row.lang)
  if (lang === null) return null
  const dueAt = row.dueAt ?? null
  const waiting = row.state === 'requested' && dueAt !== null && dueAt > now
  return {
    contentKey: row.contentKey,
    lang,
    state: (waiting ? 'waiting' : row.state) as V1TranslationState,
    chunks: row.chunkKeys.map(contentPath),
    object: row.objectKey === null ? null : contentPath(row.objectKey),
    dueAt,
  }
}

export const v1Folder = (row: {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}) => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt,
})

export const v1FeedFolder = (row: {
  feedId: number
  folderId: string | null
  updatedAt: number
}) => ({ feedId: row.feedId, folderId: row.folderId, updatedAt: row.updatedAt })

export const v1Follow = (
  row: {
    userId: string
    handle: string | null
    displayName: string | null
    avatar: string | null
    createdAt: number
    deletedAt: number | null
  },
  ctx: V1Context,
) => ({
  userId: row.userId,
  handle: str(row.handle),
  displayName: row.displayName,
  avatar: absoluteUrl(ctx.publicUrl, row.avatar),
  createdAt: row.createdAt,
  deletedAt: row.deletedAt,
})

/**
 * What a delta says Tela no longer holds, from the pull's tombstones: the posts, by id, for an app
 * that holds posts. No writer removes a post today, so it is empty, and it is in v1 from the start
 * so that one can later without a new version.
 */
export function v1Removed(
  tombstones: readonly { entity: string; key: string }[],
  types: readonly V1RowType[],
) {
  const articles = types.includes('articles')
    ? tombstones
        .filter((t) => t.entity === 'article')
        .map((t) => Number(t.key))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    : []
  return { articles }
}

// ———————————————————————————————————————————— the public side

/**
 * A post as a public list shows it, from an article row of a public answer (`titles`, a map of
 * the launch languages to its translated titles, which already leaves out a blog whose writer
 * said no) or of a search hit (`translatedTitle`, the same). Never its content key, whatever the
 * row holds.
 */
export function v1PostCard(row: Raw, siteId: number, lang: ReadingLanguage | null) {
  const titles = (row.titles ?? {}) as Record<string, unknown>
  const translated =
    'translatedTitle' in row ? row.translatedTitle : lang === null ? null : titles[lang]
  return {
    id: num(row.id),
    siteId,
    title: str(row.title),
    translatedTitle: typeof translated === 'string' ? translated : null,
    excerpt: strOrNull(row.excerpt),
    url: strOrNull(row.url),
    author: strOrNull(row.author),
    publishedAt: numOrNull(row.publishedAt),
    likeCount: num(row.likeCount),
  }
}

/** A blog as a public list shows it. A reader count below three is kept back, and reads as 0. */
export function v1BlogCard(row: Raw, ctx: V1Context) {
  const topics = Array.isArray(row.topics)
    ? row.topics.filter((t): t is string => typeof t === 'string')
    : []
  return {
    id: num(row.id),
    title: strOrNull(row.title),
    homeUrl: str(row.homeUrl),
    description: strOrNull(row.description),
    faviconUrl: absoluteUrl(ctx.assetsUrl, strOrNull(row.faviconKey)),
    primaryLang: strOrNull(row.primaryLang),
    readerCount: num(row.readerCount),
    topics,
  }
}

/** A member as a public answer names them, with the account id a follow names. */
export const v1ReaderCard = (
  row: { id: unknown; handle: unknown; displayName?: unknown; avatar?: unknown },
  ctx: V1Context,
) => ({
  userId: str(row.id),
  handle: str(row.handle),
  displayName: strOrNull(row.displayName),
  avatar: absoluteUrl(ctx.publicUrl, strOrNull(row.avatar)),
})
