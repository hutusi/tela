/**
 * A member's own picture (ADR 0033): uploaded already cropped and drawn by the reader, checked by
 * its bytes here, kept in R2 `tela-content`, and served at `/avatar/<userId>` before any Gravatar.
 * Every upload and every removal moves the picture's version, so its address is new past every
 * cache; the object it replaces is deleted. Every upload is an object of its own, under a key never
 * used before, so a deletion can only ever take the object its own change replaced: with keys
 * named by content, a removal that paused before deleting took the same picture uploaded again
 * meanwhile.
 */
import { type PictureType, pictureInfo } from '@tela/content/picture'
import { avatarOf, bumpSeq, consumeLimit, currentSeq } from '@tela/data'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'
import { readAtMost } from '../read-at-most'

/** The reader sends 256 px squares, a few dozen KB; this leaves room and no more. */
export const PICTURE_MAX_BYTES = 512 * 1024
/** Square, and small enough that no browser is asked to decode a huge canvas for a 112 px circle. */
const MIN_SIDE = 64
const MAX_SIDE = 1024
const EXT: Record<PictureType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export function pictureRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  /**
   * Put the profile's picture to `key` (null: none) in one batch, and say what it was before and
   * what the member's picture is now. A removal with nothing to remove changes nothing.
   */
  async function swap(userId: string, key: string | null, now: number) {
    const results = (await db.batch([
      db.all(sql`select avatar_key as key from profiles where user_id = ${userId}`),
      bumpSeq(db),
      db.run(sql`
        update profiles set avatar_key = ${key}, avatar_version = avatar_version + 1,
          updated_at = ${now}, seq = ${currentSeq}
        where user_id = ${userId} and (${key} is not null or avatar_key is not null)
      `),
      db.all(sql`select ${avatarOf('p')} as avatar from profiles p where p.user_id = ${userId}`),
    ] as never)) as unknown as [
      { key: string | null }[],
      unknown,
      unknown,
      { avatar: string | null }[],
    ]
    return { before: results[0][0]?.key ?? null, avatar: results[3][0]?.avatar ?? null }
  }

  /** The object a picture left behind. Best effort: one missed stays at an address nothing names. */
  async function forget(key: string | null, kept: string | null) {
    if (!key || key === kept) return
    try {
      await deps.blobs.delete(key)
    } catch (err) {
      console.error('picture not deleted', key, err)
    }
  }

  routes.put('/avatar', async (c) => {
    const member = c.get('member')
    // A length too long is refused before anything is read or spent.
    if (Number(c.req.header('content-length') ?? '0') > PICTURE_MAX_BYTES) {
      return c.json({ error: 'too_large' }, 413)
    }
    // Spent before the body is read, so an upload refused for what it is still counts: twenty an
    // hour, whatever they hold.
    const now = deps.clock.now()
    if (!(await consumeLimit(db, 'avatarUpload', member.id, now)).allowed) {
      return c.json({ error: 'rate_limited' }, 429)
    }
    // Read no further than the limit: a body sent without a length is cut off there, not held.
    let bytes: Uint8Array<ArrayBuffer> | null
    try {
      bytes = await readAtMost(c.req.raw.body, PICTURE_MAX_BYTES)
    } catch {
      return c.json({ error: 'unreadable' }, 400)
    }
    if (!bytes) return c.json({ error: 'too_large' }, 413)
    // What the bytes are, never what the request said they were.
    const info = pictureInfo(bytes)
    if (!info) return c.json({ error: 'not_a_picture' }, 415)
    if (info.width !== info.height || info.width < MIN_SIDE || info.width > MAX_SIDE) {
      return c.json({ error: 'wrong_size' }, 422)
    }
    const key = `avatars/${member.id}/${crypto.randomUUID()}.${EXT[info.type]}`
    await deps.blobs.put(key, bytes, { contentType: info.type })
    const { before, avatar } = await swap(member.id, key, now)
    await forget(before, key)
    return c.json({ avatar })
  })

  routes.delete('/avatar', async (c) => {
    const member = c.get('member')
    const { before, avatar } = await swap(member.id, null, deps.clock.now())
    await forget(before, null)
    return c.json({ avatar })
  })

  return routes
}
