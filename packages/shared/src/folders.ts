import { FOLDER_NAME_MAX } from './constants'

/**
 * A folder's name as it is kept (ADR 0048): trimmed, inner runs of space made one, no control
 * characters (tela-api refuses a name with one), and no longer than a name may be. Empty means no
 * name.
 */
export function folderName(raw: string): string {
  const cut = raw
    .replace(/\s+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, FOLDER_NAME_MAX)
  // Counted in UTF-16 units, as tela-api's check is; a cut through an emoji drops its first half,
  // which would otherwise be stored as a replacement character (a blogroll's name, counted in
  // characters, can be longer in units than a folder takes).
  return cut.replace(/[\uD800-\uDBFF]$/, '').trim()
}

/**
 * Whether two folder names are one name to a reader: case aside, accents not ("Cafe" and "Café"
 * are two folders). New folder refuses one the member has, and an OPML import files into it.
 */
export function sameFolderName(a: string, b: string): boolean {
  return folderName(a).localeCompare(folderName(b), undefined, { sensitivity: 'accent' }) === 0
}
