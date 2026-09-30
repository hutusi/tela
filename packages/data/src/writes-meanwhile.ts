/**
 * Writes that land while the nightly export reads, for the tests that hold it to reading each row
 * once (ADR 0027). No runtime-specific imports: the contract suite runs it on libSQL and on D1, and
 * the restore test in tela-api takes it from `@tela/data/testing`.
 */
import { type SQLWrapper, sql } from 'drizzle-orm'
import type { TelaDb } from './db'

/**
 * `n` cached block translations, three languages to a source hash, so a page can end partway
 * through one hash and the next has to resume on the key's second column.
 */
export async function seedBlockTranslations(db: TelaDb, n: number): Promise<void> {
  await db.run(sql`
    insert into block_translations
      (source_hash, target_lang, source_lang, tagged_text, model, norm_version, created_at)
    select printf('h%06d', value / 3),
      case value % 3 when 0 then 'en' when 1 then 'ja' else 'zh-Hans' end,
      'und', 'text ' || value, 'mock', 1, 0
    from json_each(${JSON.stringify(Array.from({ length: n }, (_, i) => i))})
  `)
}

/** A block translation's primary key as one string. */
export const blockKey = (row: Record<string, unknown>): string =>
  `${row.source_hash}|${row.target_lang}|${row.source_lang}`

/**
 * `db`, except that every page of `block_translations` it returns is followed by writes behind
 * the cursor: `added` new rows that sort before every key, then the deletion of the page's first
 * `removed` rows. A reader paging by OFFSET then reads the row at the page boundary twice (more
 * added than removed) or not at all (more removed); one paging by key does neither. `removed`
 * names the rows it deleted, which were not there throughout.
 */
export function writingMeanwhile(
  db: TelaDb,
  writes: { added: number; removed: number },
): { db: TelaDb; removed: Set<string> } {
  const removed = new Set<string>()
  let added = 0
  const all = async (query: SQLWrapper) => {
    const rows = await db.all<Record<string, unknown>>(query)
    if (!rows.some((row) => 'tagged_text' in row)) return rows
    for (let i = 0; i < writes.added; i++) {
      const hash = `a${String(added++).padStart(6, '0')}`
      await db.run(sql`
        insert into block_translations
          (source_hash, target_lang, source_lang, tagged_text, model, norm_version, created_at)
        values (${hash}, 'en', 'und', 'written meanwhile', 'mock', 1, 0)
      `)
    }
    for (const row of rows.slice(0, writes.removed)) {
      await db.run(sql`
        delete from block_translations where source_hash = ${row.source_hash}
          and target_lang = ${row.target_lang} and source_lang = ${row.source_lang}
      `)
      removed.add(blockKey(row))
    }
    return rows
  }
  const racing = new Proxy(db, {
    get: (target, prop, receiver) => (prop === 'all' ? all : Reflect.get(target, prop, receiver)),
  })
  return { db: racing, removed }
}
