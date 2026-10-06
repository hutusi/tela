/**
 * The push half of the sync protocol (ADR 0025): what a reader can change without waiting for the
 * server. Each mutation carries a client-minted id (`mid`), so a push replayed after a lost
 * response changes nothing, and the client time it was made (`at`), which decides last-writer-wins
 * conflicts across devices. The server clamps `at` to its own clock.
 *
 * Adding a feed by URL and asking for a translation are RPCs, not mutations: the reader needs the
 * answer.
 */
import {
  HIGHLIGHT_CONTEXT,
  HIGHLIGHT_NOTE_MAX,
  HIGHLIGHT_QUOTE_MAX,
  READING_LANGUAGES,
  UI_LOCALES,
} from '@tela/shared'
import { z } from 'zod'

const id = z.number().int().positive()
const base = { mid: z.string().min(8).max(64), at: z.number().int().nonnegative() }

export const PREF_KEY = /^[a-z][a-z0-9_.]{0,39}$/
/** A preference value is small JSON: theme, typography, display mode. */
export const PREF_MAX_BYTES = 2048
export const RECOMMENDATION_NOTE_MAX = 500

/** A member's account id, as public profiles name them (ADR 0031). */
const memberId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)

/** Client-minted, like `mid`, so a replayed push cannot make a second highlight. */
const highlightId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/)

export const mutationSchema = z.discriminatedUnion('type', [
  /** Opening an article reads it. Set once: a later markRead keeps the first time. */
  z.object({ ...base, type: z.literal('markRead'), articleId: id }),
  /** Absolute, not a toggle, so two devices agree; the later `at` wins. */
  z.object({ ...base, type: z.literal('setLiked'), articleId: id, liked: z.boolean() }),
  /**
   * Everything up to `upTo` is read: the highest article id the client *displayed*, so posts that
   * arrived after the reader looked are not swept up. One feed, or every feed without `feedId`.
   */
  z.object({ ...base, type: z.literal('markAllRead'), feedId: id.optional(), upTo: id }),
  z.object({ ...base, type: z.literal('subscribe'), feedId: id }),
  z.object({ ...base, type: z.literal('unsubscribe'), feedId: id }),
  z.object({
    ...base,
    type: z.literal('setPref'),
    key: z.string().regex(PREF_KEY),
    value: z.json(),
  }),
  /**
   * The member's two languages, each to the later `at` on a clock of its own (ADR 0040). A reading
   * language of null follows the interface language; one left out is left alone.
   */
  z.object({
    ...base,
    type: z.literal('setProfile'),
    readingLang: z.enum(READING_LANGUAGES).nullable().optional(),
    uiLocale: z.enum(UI_LOCALES).optional(),
  }),
  /**
   * Whether the profile shows what the member reads, and what they liked (ADR 0031). Each switch
   * goes to the later `at`, so a device reconnecting with an older choice cannot make public what
   * the member has since hidden. A type of its own: a tela-api that predates it refuses it, and
   * the switch visibly goes back, rather than acknowledging a change it then drops.
   */
  z.object({
    ...base,
    type: z.literal('setPrivacy'),
    publicSubscriptions: z.boolean().optional(),
    publicLikes: z.boolean().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('recommend'),
    articleId: id,
    note: z.string().max(RECOMMENDATION_NOTE_MAX).nullable(),
  }),
  z.object({ ...base, type: z.literal('unrecommend'), articleId: id }),
  /**
   * Whether the member's Gravatar is their picture (ADR 0032), to the later `at`. Sent on again it
   * is Refresh: the `at` is the picture's version, so its address changes. A type of its own for
   * the reason `setPrivacy` is one.
   */
  z.object({ ...base, type: z.literal('setAvatar'), gravatar: z.boolean() }),
  /**
   * Make a highlight, or change one: its note, or its anchor once the post has changed and the
   * device found the passage again. The later `at` wins, and a deleted highlight stays deleted.
   */
  z.object({
    ...base,
    type: z.literal('putHighlight'),
    id: highlightId,
    articleId: id,
    contentKey: z.string().regex(/^[0-9a-f]{32}$/),
    side: z.enum(['original', 'translation']),
    lang: z.string().max(16).nullable(),
    leafId: z.string().min(1).max(40),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string().min(1).max(HIGHLIGHT_QUOTE_MAX),
    prefix: z.string().max(HIGHLIGHT_CONTEXT * 2),
    suffix: z.string().max(HIGHLIGHT_CONTEXT * 2),
    note: z.string().max(HIGHLIGHT_NOTE_MAX).nullable(),
  }),
  /** Delete wins: no later edit from another device brings it back. */
  z.object({ ...base, type: z.literal('deleteHighlight'), id: highlightId }),
  /**
   * Follow a member, or stop (ADR 0031). Absolute, like a like: the later `at` wins. Following
   * yourself, or nobody, changes nothing.
   */
  z.object({ ...base, type: z.literal('follow'), userId: memberId }),
  z.object({ ...base, type: z.literal('unfollow'), userId: memberId }),
])

export type Mutation = z.infer<typeof mutationSchema>
export type MutationType = Mutation['type']

/** Mutations in one push. A client with more sends them in order, a push at a time. */
export const MAX_MUTATIONS_PER_PUSH = 50

export const pushSchema = z.object({ mutations: z.array(z.unknown()).max(MAX_MUTATIONS_PER_PUSH) })

export type PushResponse = {
  /** Applied now or already applied before: drop them once a pull reaches `seq`. */
  applied: string[]
  /** Refused, with why; the client drops them and rolls back its optimistic view. */
  rejected: { mid: string | null; error: string }[]
  /** The newest seq after this push. */
  seq: number
}
