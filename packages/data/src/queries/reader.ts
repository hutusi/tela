/**
 * A member's subscriptions, the folders an import files them in, and the compaction of their
 * read state.
 */
import { folderName, MAX_FOLDERS, sameFolderName } from '@tela/shared'
import { sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { bumpSeq, currentSeq } from '../seq'
import { subscribeWithinCap } from './allowances'
import { recountReaders } from './sites'

const siteOfFeed = (feedId: number) => sql`(select site_id from feeds where id = ${feedId})`

/**
 * Subscribe (or resubscribe); articles already stored count as unread from here on. Held to the
 * member's subscription cap (ADR 0063): false when they do not follow the feed after, because
 * they hold as many as the cap allows.
 */
export async function subscribe(
  db: TelaDb,
  userId: string,
  feedId: number,
  now: number,
): Promise<boolean> {
  const results = (await db.batch([
    bumpSeq(db),
    subscribeWithinCap(db, userId, feedId, now),
    ...recountReaders(db, siteOfFeed(feedId), now),
    db.all(sql`
      select 1 as following from subscriptions
      where user_id = ${userId} and feed_id = ${feedId} and deleted_at is null
    `),
  ] as never)) as unknown[]
  return (results[4] as unknown[]).length > 0
}

export async function unsubscribe(db: TelaDb, userId: string, feedId: number, now: number) {
  await db.batch([
    bumpSeq(db),
    db.run(sql`
      update subscriptions set deleted_at = ${now}, updated_at = ${now}, seq = ${currentSeq}
      where user_id = ${userId} and feed_id = ${feedId} and deleted_at is null
    `),
    ...recountReaders(db, siteOfFeed(feedId), now),
  ])
}

/**
 * Subscribe to many feeds at once (an OPML import), in one batch. Returns how many subscriptions
 * are new or revived; ones already active are left as they are.
 */
export async function subscribeMany(
  db: TelaDb,
  userId: string,
  feedIds: number[],
  now: number,
): Promise<number> {
  if (feedIds.length === 0) return 0
  const ids = JSON.stringify(feedIds)
  const results = await db.batch([
    bumpSeq(db),
    db.all(sql`
      insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at, seq)
      select ${userId}, value, 0, ${now}, ${now}, ${currentSeq} from json_each(${ids}) where true
      on conflict (user_id, feed_id) do update set
        deleted_at = null, updated_at = excluded.updated_at, seq = excluded.seq
      where subscriptions.deleted_at is not null
      returning feed_id
    `),
    ...recountReaders(
      db,
      sql`select distinct site_id from feeds where id in (select value from json_each(${ids}))`,
      now,
    ),
  ] as never)
  return ((results as unknown[])[1] as unknown[]).length
}

/** A folder an OPML import names, with the feed URLs it lists in it. */
export type ImportedFolder = { name: string; urls: string[] }

/** What an import writes: the folders it makes, and which feed goes in which folder. */
export type ImportFiling = {
  create: { id: string; name: string }[]
  file: { feedId: number; folderId: string }[]
}

/**
 * File an OPML import's blogs in the folders it names (ADR 0048), after `importFeedUrls` has
 * registered them. A name the member has a live folder for, case aside, files into that folder;
 * another makes one, while the member has fewer than MAX_FOLDERS, and past that its blogs stay
 * in none. Only a blog in no live folder is filed: an import never moves one the member filed
 * themselves. No folder is planned that would hold nothing, though one can be made empty when
 * another device files each of its blogs between the read and the write.
 */
export async function fileImportedFeeds(
  db: TelaDb,
  userId: string,
  folders: ImportedFolder[],
  now: number,
  mintId: () => string = () => crypto.randomUUID(),
): Promise<{ folders: number; filed: number }> {
  const urls = [...new Set(folders.flatMap((f) => f.urls))]
  if (urls.length === 0) return { folders: 0, filed: 0 }
  // A URL is its feed as importFeedUrls subscribed it: the one a merged feed became (ADR 0028).
  // Filed is in a live folder; a filing to none, or to a folder since deleted, is not.
  const [live, feeds] = (await db.batch([
    db.all(sql`
      select id, name from folders where user_id = ${userId} and deleted_at is null
      order by created_at, id
    `),
    db.all(sql`
      select j.value as url, coalesce(f.merged_into, f.id) as feed_id, exists (
        select 1 from feed_folders ff join folders d on d.id = ff.folder_id
        where ff.user_id = ${userId} and ff.feed_id = coalesce(f.merged_into, f.id)
          and d.deleted_at is null
      ) as filed
      from json_each(${JSON.stringify(urls)}) j join feeds f on f.feed_url = j.value
    `),
  ] as never)) as [
    { id: string; name: string }[],
    { url: string; feed_id: number; filed: number }[],
  ]

  const unfiled = new Map(feeds.filter((f) => !f.filed).map((f) => [f.url, Number(f.feed_id)]))
  const known = [...live]
  const plan: ImportFiling = { create: [], file: [] }
  const placed = new Set<number>()
  for (const group of folders) {
    const name = folderName(group.name)
    if (!name) continue
    const ids = new Set(group.urls.flatMap((url) => unfiled.get(url) ?? []))
    const into = [...ids].filter((id) => !placed.has(id))
    if (into.length === 0) continue
    let folder = known.find((f) => sameFolderName(f.name, name))
    if (!folder) {
      if (known.length >= MAX_FOLDERS) continue
      folder = { id: mintId(), name }
      known.push(folder)
      plan.create.push(folder)
    }
    for (const feedId of into) {
      placed.add(feedId)
      plan.file.push({ feedId, folderId: folder.id })
    }
  }
  return writeImportFiling(db, userId, plan, now)
}

/**
 * Write what `fileImportedFeeds` decided, in one batch. The statements hold to the same rules as
 * the decision, which was read before them: a folder made meanwhile on another device counts
 * towards MAX_FOLDERS, so the import's last folders are not made, and their blogs stay in none;
 * and a blog filed meanwhile keeps that folder.
 */
export async function writeImportFiling(
  db: TelaDb,
  userId: string,
  plan: ImportFiling,
  now: number,
): Promise<{ folders: number; filed: number }> {
  if (plan.file.length === 0) return { folders: 0, filed: 0 }
  const create = JSON.stringify(plan.create.map((f) => [f.id, f.name]))
  const file = JSON.stringify(plan.file.map((f) => [f.feedId, f.folderId]))
  const results = await db.batch([
    bumpSeq(db),
    // The count is read once, before this statement inserts anything, so `key` (each new
    // folder's place in the list) says which fit. What an import writes is no choice made at a
    // time, so it carries no clock (`updated_at` 0), as a pref taken from a browser does: the
    // server's `now` would be ahead of a device whose clock runs behind, and that device's rename
    // or move, made just after the import, would lose to it.
    db.all(sql`
      insert into folders (id, user_id, name, created_at, updated_at, seq)
      select j.value->>0, ${userId}, j.value->>1, ${now}, 0, ${currentSeq}
      from json_each(${create}) j
      where j.key < ${MAX_FOLDERS} - (
        select count(*) from folders where user_id = ${userId} and deleted_at is null)
      on conflict (id) do nothing
      returning id
    `),
    db.all(sql`
      insert into feed_folders (user_id, feed_id, folder_id, updated_at, seq)
      select ${userId}, coalesce(f.merged_into, f.id), j.value->>1, 0, ${currentSeq}
      from json_each(${file}) j join feeds f on f.id = j.value->>0
      where exists (select 1 from folders d
        where d.id = j.value->>1 and d.user_id = ${userId} and d.deleted_at is null)
      on conflict (user_id, feed_id) do update set
        folder_id = excluded.folder_id, seq = excluded.seq
      where feed_folders.folder_id is null or not exists (
        select 1 from folders d where d.id = feed_folders.folder_id and d.deleted_at is null)
      returning feed_id
    `),
  ] as never)
  const [, made, filed] = results as unknown as [unknown, unknown[], unknown[]]
  return { folders: made.length, filed: filed.length }
}

/**
 * Drop the read states a member's watermark already says (ADR 0009): read, at or below the
 * watermark of the feed's subscription, and holding nothing about a like. A row with
 * `liked_updated_at` set, liked or not, is when the last like or unlike was decided, and a like
 * pushed later from a device that made it earlier is compared against it: dropped, an unliked
 * post would take that older like. A row with `read_updated_at` set is a read or unread chosen by
 * hand, and stays for the same reason: dropped, a post marked unread would read as the watermark
 * says, and one read again would take an older unread pushed late. One statement for the nightly
 * batch; returns the article ids it dropped.
 */
export function compactReadStates(db: TelaDb) {
  return db.all<{ article_id: number }>(sql`
    delete from user_article_states
    where liked_at is null and liked_updated_at is null and read_updated_at is null and exists (
      select 1 from articles a join subscriptions s
        on s.feed_id = a.feed_id and s.user_id = user_article_states.user_id
      where a.id = user_article_states.article_id and a.id <= s.watermark_id
    )
    returning article_id
  `)
}
