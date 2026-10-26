/**
 * The Settings area (ADR 0056): every runtime setting, what holds now and its default, and
 * `setting.set`, which writes one, audited, with an undo that puts back what it replaced (the
 * previous value, or no row: the default).
 */
import { restoreSetting, setSetting, settingChangedSince, type TelaDb } from '@tela/data'
import {
  isSettingKey,
  parseSetting,
  SETTING_KEYS,
  type SettingKey,
  settingDefault,
} from '@tela/shared'
import type { AdminSettingRow, AdminSettings } from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiDeps } from '../../../deps'
import type { ActHandler, AdminEnv, Inverse } from '../framework'
import { returned, runBatch } from '../framework'

/** Every setting as the console shows it. */
export async function settingRows(db: TelaDb): Promise<AdminSettingRow[]> {
  const stored = new Map(
    (
      (await db.all(sql`select key, value, updated_at from settings`)) as {
        key: string
        value: string
        updated_at: number
      }[]
    ).map((r) => [r.key, r]),
  )
  return SETTING_KEYS.map((key) => {
    const row = stored.get(key)
    let value: unknown = settingDefault(key)
    if (row) {
      try {
        const parsed = parseSetting(key, JSON.parse(row.value))
        if (parsed.ok) value = parsed.value
      } catch {}
    }
    return {
      key,
      value,
      default: settingDefault(key),
      stored: row !== undefined,
      updatedAt: row?.updated_at ?? null,
    }
  })
}

/**
 * Set one setting. The id names the key; `args.value` is checked by that key's rule. Writing the
 * value it already holds changes nothing and is `not_applicable`.
 */
export async function applySetting(
  db: TelaDb,
  input: { key: SettingKey; value: unknown; actor: string | null; group: string; now: number },
): Promise<'done' | 'invalid' | 'not_applicable'> {
  const parsed = parseSetting(input.key, input.value)
  if (!parsed.ok) return 'invalid'
  const results = await runBatch(db, [
    ...setSetting(db, {
      key: input.key,
      value: parsed.value,
      actor: input.actor,
      group: input.group,
      now: input.now,
    }),
  ])
  return returned(results[1]).length > 0 ? 'done' : 'not_applicable'
}

const setOne: ActHandler = async (ctx, id, args) => {
  if (!isSettingKey(id)) return 'not_found'
  if (!('value' in args)) return 'invalid'
  return applySetting(ctx.deps.db, {
    key: id,
    value: args.value,
    actor: ctx.actor,
    group: ctx.group,
    now: ctx.now,
  })
}

/** Take a change back while the setting still holds what it wrote. */
const unsetOne: Inverse = (db, change, now) => {
  const to = change.to as { value?: unknown } | null
  const from = change.from as { value: unknown; stored: boolean } | null
  return {
    changed: settingChangedSince(change.targetKey, to?.value ?? null),
    restore: [restoreSetting(db, { key: change.targetKey, from, now })],
    synced: false,
  }
}

export const settingActions = { 'setting.set': setOne } as const
export const settingInverses = { 'setting.set': unsetOne } as const

export function settingRoutes(deps: ApiDeps) {
  const routes = new Hono<AdminEnv>()
  routes.get('/settings', async (c) => {
    const answer: AdminSettings = { settings: await settingRows(deps.db) }
    return c.json(answer)
  })
  return routes
}
