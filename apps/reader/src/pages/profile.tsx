import { useLocation } from 'react-router'
import { useMemberControls } from '../lib/member'
import { useTitle } from '../lib/title'
import { usePublic } from '../lib/use-public'
import { useNow } from '../store/hooks'
import { useUi } from '../ui'
import { ProfileView } from '../views/profile'
import type { ProfileData } from '../views/types'
import { NotFoundPage } from './not-found'

/** `/@handle`: the first segment is the literal "@handle"; anything else is not a profile. */
export function handleFrom(pathname: string): string | null {
  const segment = decodeURIComponent(pathname.split('/')[1] ?? '')
  const handle = segment.startsWith('@') ? segment.slice(1).toLowerCase() : ''
  return /^[a-z0-9_]{1,30}$/.test(handle) && pathname.split('/').length === 2 ? handle : null
}

export const profilePath = (handle: string) => `/api/v1/public/profiles/${handle}`

export function ProfilePage() {
  const handle = handleFrom(useLocation().pathname)
  const loaded = usePublic<ProfileData>(handle ? profilePath(handle) : null)
  const member = useMemberControls()
  const { locale } = useUi()
  const now = useNow()
  useTitle(handle ? `@${handle}` : null)
  if (!handle || loaded.status === 'missing') return <NotFoundPage />
  if (loaded.status !== 'ready') return <main className="flex-1" aria-busy="true" />
  return <ProfileView data={loaded.data} member={member} locale={locale} now={now} />
}
