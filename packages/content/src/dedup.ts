import { sha256Hex } from './hash'
import { normalizeForDedup } from './url'

export type DedupInput = {
  guid: string | null
  url: string | null
  title: string
  publishedAt: Date | null
}

/**
 * Dedup ladder: guid, then the normalized link, then a hash of title and date.
 * Prefixes keep the rungs from colliding with each other.
 */
export async function dedupKey(item: DedupInput): Promise<string> {
  const guid = item.guid?.trim()
  if (guid) return `g:${guid}`
  const link = item.url ? normalizeForDedup(item.url) : null
  if (link) return `u:${link}`
  const stamp = item.publishedAt ? item.publishedAt.toISOString() : ''
  return `h:${await sha256Hex(`${item.title.trim()}|${stamp}`)}`
}
