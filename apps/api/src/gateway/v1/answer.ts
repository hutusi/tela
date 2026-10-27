/**
 * What every v1 route answers with (ADR 0065): the absolute URLs' bases, the cache an answer
 * allows, refusals in the API's own words, and who a call acts for. An app is never exempt from a
 * member limit, whoever the member is (ADR 0064), so every actor here says `exempt: false`.
 */
import { type Actor, first } from '@tela/data'
import { readingLanguage, type V1Context } from '@tela/ext/transform'
import type { ReadingLanguage } from '@tela/shared'
import { sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiDeps } from '../../deps'
import type { GatewayEnv } from '../auth'

/** tela-assets' public base when tela-api is told none. */
export const DEFAULT_ASSETS_URL = 'https://assets.telaread.com'

export const v1Context = (config: ApiDeps['config']): V1Context => ({
  publicUrl: config.publicUrl,
  assetsUrl: config.assetsUrl ?? DEFAULT_ASSETS_URL,
})

/** Who a call acts for: the token's member, never exempt. */
export const actorOf = (c: Context<GatewayEnv>): Actor => ({
  userId: c.get('app').userId,
  exempt: false,
})

/** Kept by nobody: anything that depends on who asks. */
export const PRIVATE = { 'cache-control': 'private, no-store' }
/** The same for every viewer: tela-gateway keeps it per colo, and so may anyone. */
export const PUBLIC = { 'cache-control': 'public, max-age=300' }

/** A refusal: `{ error, … }` with its status, never cached. */
export function refuse(
  c: Context<GatewayEnv>,
  status: ContentfulStatusCode,
  error: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return c.json({ error, ...extra }, status, { 'cache-control': 'no-store', ...headers })
}

/** 429 with how long to wait: `Retry-After` in whole seconds, at least one. */
export function tooMany(
  c: Context<GatewayEnv>,
  error: string,
  retryAfterSec: number,
  extra: Record<string, unknown> = {},
) {
  return refuse(c, 429, error, extra, {
    'retry-after': String(Math.max(1, Math.ceil(retryAfterSec))),
  })
}

/** Seconds from `now` until `at`, for a `Retry-After`. */
export const secondsUntil = (at: number, now: number) => Math.max(1, Math.ceil((at - now) / 1000))

/**
 * The language a member reads posts in, for an answer that names no `lang`: their reading
 * language, else their interface language when it is one (null follows the interface, ADR 0040),
 * else none, and no translated title is given.
 */
export async function memberLanguage(
  db: ApiDeps['db'],
  userId: string,
): Promise<ReadingLanguage | null> {
  const row = await first<{ reading_lang: string | null; ui_locale: string | null }>(
    db,
    sql`select reading_lang, ui_locale from profiles where user_id = ${userId}`,
  )
  return readingLanguage(row?.reading_lang) ?? readingLanguage(row?.ui_locale)
}
