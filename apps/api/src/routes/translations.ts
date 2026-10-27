/**
 * A reader asking for an article's body in their language (ADR 0023): an RPC, because the reader
 * needs the answer. The rules are `core/translations.ts`, which the API's `/v1/translations`
 * shares (ADR 0065); this is the web's wording of them, which a cached shell reads.
 */
import type { BodyAllowance, BodyTranslationRow } from '@tela/data'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import {
  type BodyTranslationAnswer,
  type ExhaustedReason,
  requestBodyTranslation,
  translationStatus,
} from '../core/translations'
import type { ApiDeps } from '../deps'
import { webActor } from '../web-actor'

export {
  type ExhaustedReason,
  exhaustedReason,
  isScriptConversion,
  reservationFor,
  sourceGuessFor,
} from '../core/translations'

export type TranslationRequestStatus =
  | 'requested'
  /** Admitted for tomorrow: the row waits until its `dueAt` (ADR 0057). */
  | 'scheduled'
  | 'in_progress'
  | 'ready'
  | 'invalid'
  | 'unavailable'
  | 'rate_limited'
  | 'budget_exhausted'

/** The member's count as the answer to a request leaves it; `perDay` null is no limit. */
export type TranslationAllowance = { perDay: number | null; usedToday: number; resetsAt: number }

/**
 * What the reader sees of a translation: never who asked or what it cost. The seq lets it tell
 * this answer from a synced row of an earlier attempt, which a pull can bring after it. `dueAt`
 * says a request waits for its day (ADR 0057).
 */
const view = (row: BodyTranslationRow) => ({
  contentKey: row.contentKey,
  lang: row.lang,
  state: row.state,
  chunkKeys: row.chunkKeys,
  objectKey: row.objectKey,
  failedLeaves: row.failedLeaves,
  dueAt: row.dueAt,
  seq: row.seq,
})

/** An answer as the web words it: its status, the row, and the member's day where it was read. */
function body(
  status: TranslationRequestStatus,
  row: BodyTranslationRow | null,
  extra: { allowance?: BodyAllowance | undefined; reason?: ExhaustedReason } = {},
) {
  return {
    status,
    translation: row ? view(row) : null,
    ...(extra.reason ? { reason: extra.reason, resetsAt: extra.allowance?.resetsAt ?? null } : {}),
    ...(extra.allowance
      ? {
          allowance: {
            perDay: extra.allowance.perDay,
            usedToday: extra.allowance.usedToday,
            resetsAt: extra.allowance.resetsAt,
          } satisfies TranslationAllowance,
        }
      : {}),
  }
}

/** The web's answer to an ask, and its HTTP status. */
function worded(answer: BodyTranslationAnswer): { json: unknown; code: 200 | 400 | 404 | 429 } {
  switch (answer.status) {
    case 'bad_request':
      return { json: body('invalid', null), code: 400 }
    case 'not_found':
      return { json: { error: 'not_found' }, code: 404 }
    case 'unavailable':
    case 'invalid':
      return { json: body(answer.status, null), code: 200 }
    case 'ready':
      return { json: body('ready', answer.translation), code: 200 }
    case 'requested':
    case 'scheduled':
    case 'in_progress':
      return {
        json: body(answer.status, answer.translation, { allowance: answer.allowance }),
        code: 200,
      }
    case 'rate_limited':
      return { json: body('rate_limited', answer.translation), code: 429 }
    case 'budget_exhausted':
      return {
        json: body('budget_exhausted', answer.translation, {
          allowance: answer.allowance,
          reason: answer.reason,
        }),
        code: 200,
      }
  }
}

export function translationRoutes(deps: ApiDeps) {
  const routes = new Hono<ApiEnv>()

  routes.post('/', async (c) => {
    const actor = await webActor(c, deps.db)
    const input = await c.req
      .json<{ articleId?: unknown; lang?: unknown }>()
      .catch(() => ({}) as Record<string, unknown>)
    const { json, code } = worded(
      await requestBodyTranslation(deps, actor, {
        articleId: Number(input.articleId),
        lang: typeof input.lang === 'string' ? input.lang : '',
      }),
    )
    return c.json(json, code)
  })

  // Polled while an article is open and its translation streams in: what exists right now. The
  // device hides a translation its writer turned off, so the web is answered it as it stands.
  routes.get('/:contentKey/:lang', async (c) => {
    const { translation } = await translationStatus(
      deps,
      c.req.param('contentKey'),
      c.req.param('lang'),
    )
    if (!translation) return c.json({ error: 'not_found' }, 404, { 'cache-control': 'no-store' })
    return c.json(view(translation), 200, { 'cache-control': 'no-store' })
  })

  return routes
}
