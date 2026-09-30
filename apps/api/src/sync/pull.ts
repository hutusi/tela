/**
 * Answering a pull (ADR 0025): read in one batch (`readPull`), then shape SQLite's rows into the
 * protocol's. SQLite hands back booleans as 0/1 and JSON as text; the client gets neither.
 */
import { type RawRow, readPull, type TelaDb } from '@tela/data'
import { emptyRows, HORIZON_DAYS, PAGE_ROWS, type PullResponse, type SyncRows } from '@tela/sync'

const DAY = 24 * 60 * 60 * 1000
const bool = (v: unknown) => v === 1 || v === true
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

function shape(rows: Record<keyof SyncRows, RawRow[]>): SyncRows {
  const out = emptyRows()
  out.profile = rows.profile.map((r) => ({
    ...(r as Omit<SyncRows['profile'][number], 'publicSubscriptions'>),
    publicSubscriptions: bool(r.publicSubscriptions),
  }))
  out.prefs = rows.prefs.map((r) => ({
    key: String(r.key),
    value: json(r.valueJson, null),
    updatedAt: Number(r.updatedAt),
    seq: Number(r.seq),
  }))
  out.sites = rows.sites.map((r) => ({
    ...(r as unknown as SyncRows['sites'][number]),
    owned: bool(r.owned),
    claimed: bool(r.claimed),
    translationOptOut: bool(r.translationOptOut),
  }))
  out.translations = rows.translations.map((r) => ({
    ...(r as unknown as SyncRows['translations'][number]),
    chunkKeys: json<string[]>(r.chunkKeys, []),
    failedLeaves: json<string[]>(r.failedLeaves, []),
  }))
  for (const name of [
    'subscriptions',
    'feeds',
    'articles',
    'titles',
    'states',
    'recommendations',
    'highlights',
    'claims',
  ] as const) {
    ;(out[name] as RawRow[]) = rows[name]
  }
  return out
}

export async function answerPull(
  db: TelaDb,
  userId: string,
  cursor: number,
  now: number,
): Promise<PullResponse> {
  const horizon = now - HORIZON_DAYS * DAY
  let read = await readPull(db, { userId, cursor, horizon, limit: PAGE_ROWS })
  let reset = cursor === 0
  if (cursor > read.head) {
    // A cursor from the future: the database was restored behind this client. Start it over.
    read = await readPull(db, { userId, cursor: 0, horizon, limit: PAGE_ROWS })
    reset = true
  }
  return {
    cursor: read.pageEnd ?? read.head,
    more: read.pageEnd !== null,
    reset,
    rows: shape(read.rows),
    tombstones: read.tombstones.map((t) => ({
      entity: String(t.entity),
      key: String(t.key),
      seq: Number(t.seq),
    })),
  }
}
