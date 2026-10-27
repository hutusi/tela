/** Every ledger area's hook, by area. The shell calls the one the address names. */
import type { LedgerArea } from '@tela/shared/admin'
import type { AnyAreaSpec } from '../area'
import { useAppsArea } from './apps'
import { useClaimsArea } from './claims'
import { useDiscoverArea } from './discover'
import { useFeedsArea } from './feeds'
import { useInvitesArea } from './invites'
import { usePeopleArea } from './people'
import { useReportsArea } from './reports'
import { useSettingsArea } from './settings'
import { useSitesArea } from './sites'
import { useSystemArea } from './system'
import { useTranslationArea } from './translation'

export const AREA_HOOKS: Record<LedgerArea, () => AnyAreaSpec | null> = {
  claims: useClaimsArea,
  reports: useReportsArea,
  sites: useSitesArea,
  feeds: useFeedsArea,
  discover: useDiscoverArea,
  people: usePeopleArea,
  invites: useInvitesArea,
  apps: useAppsArea,
  translation: useTranslationArea,
  system: useSystemArea,
  settings: useSettingsArea,
}
