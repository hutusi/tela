/**
 * Settings › Subscriptions' folders (ADR 0048, Tela Lists): which group each of its rows is in,
 * whether a name may be given, and the changes a new folder or an Undo makes. Pure, over the
 * device's tables, so the page and its tests agree.
 */
import { folderName, MAX_FOLDERS, sameFolderName } from '@tela/shared'
import type { Tables } from '@tela/sync'
import type { MutationInput } from '../store/local'
import { folderIdOf, folderTree } from '../store/selectors'
import { newId } from './id'

/** A folder's rows on the page. */
export type FolderGroup<R> = { id: string; name: string; rows: R[] }

/**
 * Settings' rows by folder: the folders by name (as everywhere, `folderTree`), each with its rows
 * in the order given, then the rows in none. A row is any blog the page lists, a dimmed one left
 * from it included: a filing outlives an unsubscribe, so it stays in its folder, and taking it
 * back leaves it where it was.
 */
export function groupRows<R extends { feedId: number }>(
  t: Tables,
  now: number,
  rows: readonly R[],
): { folders: FolderGroup<R>[]; unfiled: R[] } {
  const folders = folderTree(t, now).folders.map(
    (f): FolderGroup<R> => ({ id: f.id, name: f.name, rows: [] }),
  )
  const byId = new Map(folders.map((f) => [f.id, f]))
  const unfiled: R[] = []
  for (const row of rows) {
    const group = byId.get(folderIdOf(t, row.feedId) ?? '')
    if (group) group.rows.push(row)
    else unfiled.push(row)
  }
  return { folders, unfiled }
}

export type NameCheck = { ok: string } | { empty: true } | { taken: string }

/**
 * Whether `raw` may name a folder: as it would be kept (`folderName`), unless that is empty, or
 * one of the member's folders already has it (`sameFolderName`), in which case it says which.
 * `self` is the folder being renamed, whose own name is no clash: "cities" may become "Cities".
 */
export function checkFolderName(
  raw: string,
  folders: Iterable<{ id: string; name: string }>,
  self?: string,
): NameCheck {
  const name = folderName(raw)
  if (name === '') return { empty: true }
  for (const f of folders) {
    if (f.id !== self && sameFolderName(f.name, name)) return { taken: f.name }
  }
  return { ok: name }
}

/**
 * The folders a name or the limit must reckon with: those the page shows, and those the server
 * still holds though the page does not, a folder whose deletion is held while its Undo shows
 * (ADR 0046). Until the deletion goes, its name is not free, and it still counts towards the
 * limit: made meanwhile and then undone, a folder of the same name would be a second one, and one
 * past the limit would vanish with everything moved into it. By name, the page's own first.
 */
export function knownFolders(
  shown: Pick<Tables, 'folders'>,
  confirmed: ReadonlyMap<string, { id: string; name: string }>,
): { id: string; name: string }[] {
  const known = new Map<string, { id: string; name: string }>()
  for (const f of confirmed.values()) known.set(f.id, { id: f.id, name: f.name })
  for (const f of shown.folders.values()) known.set(f.id, { id: f.id, name: f.name })
  return [...known.values()]
}

/** Whether another folder can be made: the server makes none past `MAX_FOLDERS`. */
export const canMakeFolder = (known: readonly unknown[]) => known.length < MAX_FOLDERS

/**
 * The blogs filed in a folder, followed or not (a blog left from Settings keeps its filing): what
 * an Undo of its deletion puts back.
 */
export function filedIn(t: Pick<Tables, 'feedFolders'>, folderId: string): number[] {
  const out: number[] = []
  for (const row of t.feedFolders.values()) if (row.folderId === folderId) out.push(row.feedId)
  return out.sort((a, b) => a - b)
}

/**
 * A folder made with blogs filed in it, as one change: the phone's Move sheet making a folder for
 * the blog it moves, and an Undo of a deletion that already went to the server. That Undo makes
 * the folder again under a new id, since a deleted folder's id stays deleted.
 */
export function folderWith(
  name: string,
  feedIds: readonly number[],
  id: string = newId(),
): MutationInput[] {
  return [
    { type: 'putFolder', id, name },
    ...feedIds.map((feedId) => ({ type: 'fileFeed', feedId, folderId: id }) as const),
  ]
}
