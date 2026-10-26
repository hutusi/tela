/**
 * For writers (`/writers`), for anyone: who is here (a visitor gets the form), the member's own
 * handle, and how many blogs are public. The page itself is `views/writers.tsx`, which the edge
 * renders too (ADR 0061 moved it there, as ADR 0035 said it could once the beta ended).
 */
import { useEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { useTranslations } from 'use-intl'
import { safeDecode } from '../lib/safe-decode'
import { useTitle } from '../lib/title'
import { usePublic } from '../lib/use-public'
import { useSession } from '../session'
import { useNow, useStore, useTables } from '../store/hooks'
import { useUi } from '../ui'
import { WritersView } from '../views/writers'

export { type Availability, availabilityOf } from '../views/writers'

/** The part of the front page's JSON this page reads: how many blogs are public. */
type FrontCounts = { counts?: { blogs?: unknown } }

export function WritersPage() {
  const t = useTranslations('writers')
  useTitle(t('title'))
  const { status } = useSession()
  const { store } = useStore()
  const tables = useTables()
  const { locale } = useUi()
  const now = useNow()
  // As the header decides: a device known to hold no member gets the form at once.
  const visitor = status === 'guest' || (status === 'unknown' && store.userId === null)

  const front = usePublic<FrontCounts>('/api/v1/public/front')
  const counted = front.status === 'ready' ? front.data.counts?.blogs : undefined
  const blogs = typeof counted === 'number' && counted > 0 ? counted : null

  // An anchor reached from another screen of the app (the Dashboard's "How Tela reads your
  // blog") is a render, not a load, so the section is found here; one the browser loaded, it
  // found itself, in the edge's copy (as on the info pages).
  const { hash } = useLocation()
  const navigation = useNavigationType()
  useEffect(() => {
    if (hash.length > 1) {
      const id = safeDecode(hash.slice(1))
      if (id) document.getElementById(id)?.scrollIntoView()
    } else if (navigation !== 'POP') window.scrollTo(0, 0)
  }, [hash, navigation])

  return (
    <WritersView
      visitor={visitor}
      ownHandle={tables.profile?.handle ?? null}
      blogs={blogs}
      locale={locale}
      now={now}
    />
  )
}
