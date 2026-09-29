import { useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { discoverApiPath, parseDiscoverParams } from '../lib/discover-href'
import { useMemberControls } from '../lib/member'
import { useTitle } from '../lib/title'
import { usePublic } from '../lib/use-public'
import { useUi } from '../ui'
import { DiscoverView } from '../views/discover'
import type { DiscoverData } from '../views/types'

export function DiscoverPage() {
  const [search] = useSearchParams()
  const params = parseDiscoverParams(search)
  const loaded = usePublic<DiscoverData>(discoverApiPath(params))
  const member = useMemberControls()
  const { locale } = useUi()
  useTitle(useTranslations('nav')('discover'))
  return (
    <DiscoverView
      data={
        loaded.status === 'ready'
          ? loaded.data
          : loaded.status === 'missing'
            ? { sites: [], languages: [] }
            : null
      }
      params={params}
      member={member}
      locale={locale}
    />
  )
}
