/** The sidebar's order and groups, as the design lists them, and where each area's badge comes from. */
import type { AdminArea, AdminCounts, LedgerArea } from '@tela/shared/admin'

export type NavGroup = 'queues' | 'library' | 'members' | 'running'

export const NAV: readonly { group: NavGroup | null; areas: readonly AdminArea[] }[] = [
  { group: null, areas: ['overview'] },
  { group: 'queues', areas: ['claims'] },
  { group: 'library', areas: ['sites', 'feeds', 'discover'] },
  { group: 'members', areas: ['people', 'invites'] },
  { group: 'running', areas: ['translation', 'system'] },
]

/** The group an area's header names above its title. */
export const AREA_GROUP: Record<LedgerArea, NavGroup> = {
  claims: 'queues',
  sites: 'library',
  feeds: 'library',
  discover: 'library',
  people: 'members',
  invites: 'members',
  translation: 'running',
  system: 'running',
}

/** What waits in an area, for its badge: only the queues have one. */
export function badgeOf(area: AdminArea, counts: AdminCounts | null): number {
  if (!counts) return 0
  if (area === 'claims') return counts.claims
  if (area === 'feeds') return counts.feeds
  if (area === 'system') return counts.dead
  return 0
}
