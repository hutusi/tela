/**
 * The card For writers shows before a visitor types, and what its sections draw from: a sample,
 * labelled as one on the page (ADR 0037), with the design's cast. A member's live card was the
 * example until then, and through the beta it stayed three lines long. Everything here is something
 * Tela does (a claimed blog, a bio, followers, recommendations with a note, blogs read in public,
 * and the three kinds of row on Following), but none of it is anyone's: nothing drawn from it links
 * anywhere, since `/@lucia` may be a real member's one day. The one place the cast is named.
 *
 * Titles are in the catalogs (`writers.sample.posts`), since Tela shows a post's title in the
 * reader's language; a bio and a note stay as their writer wrote them, as Tela leaves them.
 */
import { personColor, swatchColor } from './format'

export type SamplePerson = { handle: string; name: string }

/** A post on the sample, by its key under `writers.sample.posts`. */
export type SamplePost = 'granVia' | 'kitchen'

export type SampleBlog = { name: string; color: string }

/** One row of a Following page, as the activity card draws it; the rows are newest first, as there. */
export type SampleActivity = {
  kind: 'recommended' | 'liked' | 'subscribed'
  who: SamplePerson
  /** The blog the writer of the row writes. */
  writes: SampleBlog
  /** The blog the post is from, or the one subscribed to. */
  blog: SampleBlog
  /** The post recommended or liked; a subscription names its blog alone. */
  post: SamplePost | null
  note: string | null
  /** How long ago, in milliseconds. */
  ago: number
}

const person = (handle: string, name: string): SamplePerson => ({ handle, name })
// A blog's swatch is its writer's colour, as the design draws them.
const blogOf = (name: string, writer: SamplePerson | null, n = 0): SampleBlog => ({
  name,
  color: writer ? personColor(writer.handle) : swatchColor(n),
})

const LUCIA = person('lucia', 'Lucía Ferrer')
const TOM = person('tom', 'Tom Adeyemi')
const PRIYA = person('priya', 'Priya Nair')
const SATO = person('sato', '佐藤 恵')
const ANKE = person('anke', 'Anke Wirth')

const KILOMETRO = blogOf('Kilómetro Cero', LUCIA)
const SLOW = blogOf('Slow Machines', TOM)
const ROOMS = blogOf('Little Rooms', PRIYA)
const HANTOU = blogOf('半島日記', SATO)
const PFAD = blogOf('Pfadfinder', ANKE)
const TYPEWRITTEN = blogOf('Typewritten', null, 5)

const GRAN_VIA_NOTE = 'The best thing I’ve read about a city waking up.'
const KITCHEN_NOTE = 'Proof that a rented flat can feel like home.'

const MINUTE = 60_000

const ACTIVITY: SampleActivity[] = [
  {
    kind: 'recommended',
    who: TOM,
    writes: SLOW,
    blog: KILOMETRO,
    post: 'granVia',
    note: GRAN_VIA_NOTE,
    ago: 12 * MINUTE,
  },
  {
    kind: 'subscribed',
    who: PRIYA,
    writes: ROOMS,
    blog: KILOMETRO,
    post: null,
    note: null,
    ago: 40 * MINUTE,
  },
  {
    kind: 'liked',
    who: SATO,
    writes: HANTOU,
    blog: KILOMETRO,
    post: 'granVia',
    note: null,
    ago: 60 * MINUTE,
  },
  {
    kind: 'recommended',
    who: LUCIA,
    writes: KILOMETRO,
    blog: ROOMS,
    post: 'kitchen',
    note: KITCHEN_NOTE,
    ago: 120 * MINUTE,
  },
]

export const SAMPLE = {
  writer: LUCIA,
  /** Not a real address (it resolves nowhere), and shown as text only. */
  host: 'kilometrocero.blog',
  blog: KILOMETRO,
  bio: 'Walking notes from Madrid, mostly written before breakfast.',
  counts: { followers: 48, recommendations: 23, reads: 24 },
  /** How many read the claimed blog on Tela. */
  blogReaders: 61,
  latest: { post: 'kitchen' as SamplePost, note: KITCHEN_NOTE },
  reads: [SLOW, HANTOU, ROOMS, PFAD],
  activity: ACTIVITY,
  roll: [SLOW, HANTOU, TYPEWRITTEN, ROOMS],
}

export type Sample = typeof SAMPLE
