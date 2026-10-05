/**
 * The admin console's write path (ADR 0039). An action runs once per target, each target in a
 * batch of its own that writes its audit row first (`audit` in `@tela/data`), and every target of
 * one request shares a group id, which is also the undo token. An undo restores what each audit
 * row says was there, in one batch whose guards abort it whole when any target moved on since.
 */
import type { TelaDb } from '@tela/data'
import type { AdminActArgs, AdminActError, AdminActionName } from '@tela/shared/admin'
import type { SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Hono } from 'hono'
import type { ApiEnv } from '../../app'
import type { Auth } from '../../auth'
import type { ApiDeps } from '../../deps'

export type AdminEnv = ApiEnv

export type ActContext = {
  deps: ApiDeps
  auth: Auth
  /** The admin acting: the session's member. */
  actor: string
  /** This request's group: the audit rows' `group_id`, and the undo token. */
  group: string
  now: number
}

/**
 * Apply an action to one target, committing its own batch (audit row included). `done` when it
 * changed something; otherwise why it did not apply. `id` is `''` for `code.create` and
 * `invite.address`, which name no existing target.
 */
export type ActHandler = (
  ctx: ActContext,
  id: string,
  args: AdminActArgs,
) => Promise<'done' | AdminActError>

/** An audit row as an inverse reads it. */
export type AuditedChange = { targetKey: string; from: unknown; to: unknown }

/**
 * How to take back one audited change. `changed` is true (as SQL) when the target no longer holds
 * what the action wrote; `restore` puts `from` back. `synced` says whether `restore` writes a row
 * readers sync, so the batch starts with `bumpSeq` and `restore` stamps `currentSeq`.
 */
export type Inverse = (
  db: TelaDb,
  change: AuditedChange,
  now: number,
) => { changed: SQL; restore: BatchItem<'sqlite'>[]; synced: boolean }

/** One group of areas' routes, and the actions and inverses it brings. */
export type AdminModule = {
  routes: Hono<AdminEnv>
  actions: Partial<Record<AdminActionName, ActHandler>>
  inverses: Partial<Record<AdminActionName, Inverse>>
}

/** Run a batch built from a list, for code that assembles it from parts. */
export async function runBatch(db: TelaDb, items: BatchItem<'sqlite'>[]): Promise<unknown[][]> {
  if (items.length === 0) return []
  return (await db.batch(items as never)) as unknown as unknown[][]
}

/** The rows a `RETURNING` statement in a batch gave back. */
export const returned = (result: unknown): unknown[] => (Array.isArray(result) ? result : [])

/**
 * A search's filter and words from a POST body, or null when the body is not one. Searches that
 * may hold an email address are posted rather than put in the URL, which reaches the Workers'
 * logs (ADR 0039).
 */
export async function searchBody(request: Request): Promise<{ f?: string; q: string } | null> {
  const body = (await request.json().catch(() => null)) as { f?: unknown; q?: unknown } | null
  if (typeof body !== 'object' || body === null) return null
  if (body.f !== undefined && typeof body.f !== 'string') return null
  if (body.q !== undefined && (typeof body.q !== 'string' || body.q.length > 200)) return null
  return { ...(typeof body.f === 'string' ? { f: body.f } : {}), q: body.q ?? '' }
}
