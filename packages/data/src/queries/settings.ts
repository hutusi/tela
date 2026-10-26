/**
 * Runtime settings (ADR 0056). A statement that enforces a limit reads the setting inline with
 * `settingSql`, so it is never older than the statement and costs no round trip of its own;
 * `readSettings` reads them all for the few paths that decide in JavaScript. A stored value that
 * no longer parses (a key's rule tightened since) reads as the default.
 */
import {
  defaultSettings,
  isSettingKey,
  parseSetting,
  type SettingKey,
  type Settings,
  type SettingValue,
  settingDefault,
} from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { audit } from './admin'

/**
 * The setting's value as an SQL expression: the stored row's, else the default. A stored `null`
 * (no limit) is a value, so this does not `coalesce` it into the default.
 */
export function settingSql(key: SettingKey): SQL {
  const fallback = JSON.stringify(settingDefault(key))
  return sql`(select case when count(*) = 0 then json_extract(${fallback}, '$')
    else json_extract(max(value), '$') end from settings where key = ${key})`
}

/** Every setting, stored or default. */
export async function readSettings(db: TelaDb): Promise<Settings> {
  const rows = (await db.all(sql`select key, value from settings`)) as {
    key: string
    value: string
  }[]
  const settings = defaultSettings()
  for (const row of rows) {
    if (!isSettingKey(row.key)) continue
    let raw: unknown
    try {
      raw = JSON.parse(row.value)
    } catch {
      continue
    }
    const parsed = parseSetting(row.key, raw)
    if (parsed.ok) (settings as Record<string, unknown>)[row.key] = parsed.value
  }
  return settings
}

/** One setting, stored or default. */
export async function readSetting<K extends SettingKey>(
  db: TelaDb,
  key: K,
): Promise<SettingValue<K>> {
  return (await readSettings(db))[key]
}

/**
 * The statements that set `key` to `value`, audited as `setting.set`: the audit row (written only
 * when the value changes) and the upsert, which returns the key when it changed something. A value
 * equal to the default is stored all the same, so the log and the table agree on what was chosen.
 * `value` must already have passed `parseSetting`.
 */
export function setSetting<K extends SettingKey>(
  db: TelaDb,
  input: {
    key: K
    value: SettingValue<K>
    actor: string | null
    group: string
    now: number
  },
) {
  const json = JSON.stringify(input.value)
  const current = sql`(select value from settings where key = ${input.key})`
  return [
    audit(
      db,
      {
        group: input.group,
        actor: input.actor,
        action: 'setting.set',
        targetKind: 'setting',
        targetKey: input.key,
        at: input.now,
      },
      {
        // `from` is null when nothing was stored: the default held, and an undo deletes the row.
        from: sql`json_object('value', json(${current}), 'stored', ${current} is not null)`,
        to: { value: input.value, stored: true },
      },
      sql`where ${current} is null or json(${current}) is not json(${json})`,
    ),
    db.all(sql`
      insert into settings (key, value, updated_at, updated_by)
      values (${input.key}, json(${json}), ${input.now}, ${input.actor})
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
      where settings.value is not excluded.value
      returning key
    `),
  ] as const
}

/**
 * Put back what a `setting.set` replaced: the stored value, or no row (the default). For the
 * console's undo, guarded by the caller on the row still holding what the action wrote.
 */
export function restoreSetting(
  db: TelaDb,
  input: { key: string; from: { value: unknown; stored: boolean } | null; now: number },
) {
  if (!input.from?.stored) return db.run(sql`delete from settings where key = ${input.key}`)
  const json = JSON.stringify(input.from.value)
  return db.run(sql`
    insert into settings (key, value, updated_at, updated_by)
    values (${input.key}, json(${json}), ${input.now}, null)
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at,
      updated_by = null
  `)
}

/** Whether the stored row no longer holds `value` (true as SQL): an undo's `changed`. */
export function settingChangedSince(key: string, value: unknown): SQL {
  const json = JSON.stringify(value)
  return sql`not exists (select 1 from settings where key = ${key} and json(value) is json(${json}))`
}
