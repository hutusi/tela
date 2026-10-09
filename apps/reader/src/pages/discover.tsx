import { useEffect } from 'react'
import { useNavigationType, useSearchParams } from 'react-router'
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
  // A page the pager opened starts at its top: one already held renders at once, and the browser
  // would keep the scroll of the page left, deep in the next one's grid. Back and Forward (`POP`)
  // stay where the browser puts them, as the info pages do.
  const navigation = useNavigationType()
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each page, as it was reached
  useEffect(() => {
    if (navigation !== 'POP') window.scrollTo(0, 0)
  }, [params.page])
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
