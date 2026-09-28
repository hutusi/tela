/**
 * The push half of the sync protocol (ADR 0025): what a reader can change without waiting for the
 * server. Each mutation carries a client-minted id (`mid`), so a push replayed after a lost
 * response changes nothing, and the client time it was made (`at`), which decides last-writer-wins
 * conflicts across devices. The server clamps `at` to its own clock.
 *
 * Adding a feed by URL and asking for a translation are RPCs, not mutations: the reader needs the
 * answer.
 */
import { READING_LANGUAGES, UI_LOCALES } from '@tela/shared'
import { z } from 'zod'

const id = z.number().int().positive()
const base = { mid: z.string().min(8).max(64), at: z.number().int().nonnegative() }

export const PREF_KEY = /^[a-z][a-z0-9_.]{0,39}$/
/** A preference value is small JSON: theme, typography, display mode. */
export const PREF_MAX_BYTES = 2048
export const RECOMMENDATION_NOTE_MAX = 500

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
  z.object({
    ...base,
    type: z.literal('setProfile'),
    readingLang: z.enum(READING_LANGUAGES).optional(),
    uiLocale: z.enum(UI_LOCALES).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('recommend'),
    articleId: id,
    note: z.string().max(RECOMMENDATION_NOTE_MAX).nullable(),
  }),
  z.object({ ...base, type: z.literal('unrecommend'), articleId: id }),
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
