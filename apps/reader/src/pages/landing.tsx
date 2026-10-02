/**
 * The front page for visitors (ADR 0035). The edge renders it with the edition handed over; a
 * returning visitor's service worker answers with the plain shell instead, so the edition loads
 * here, and only it shows a skeleton meanwhile.
 */
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { FRONT_PATH, titlesMode } from '../lib/edition'
import { useMemberControls } from '../lib/member'
import { useTitle } from '../lib/title'
import { usePublic } from '../lib/use-public'
import { useReadingLang } from '../store/hooks'
import { useUi } from '../ui'
import { LandingView } from '../views/landing'
import type { FrontData } from '../views/types'

export function LandingPage() {
  const [search] = useSearchParams()
  const loaded = usePublic<FrontData>(FRONT_PATH)
  const member = useMemberControls()
  const { locale } = useUi()
  const reading = useReadingLang(locale)
  const [now] = useState(() => Date.now())
  useTitle(null)
  return (
    <LandingView
      data={loaded.status === 'ready' ? loaded.data : null}
      loading={loaded.status === 'loading'}
      titles={titlesMode(search)}
      reading={reading}
      locale={locale}
      now={now}
      member={member}
    />
  )
}
