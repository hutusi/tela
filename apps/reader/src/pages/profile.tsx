import { useEffect, useMemo, useRef } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { useMemberControls } from '../lib/member'
import { readingPrefsOf } from '../lib/prefs'
import { useTitle } from '../lib/title'
import { forgetPublic, usePublic } from '../lib/use-public'
import { useNow, useReadingLang, useTables } from '../store/hooks'
import { useUi } from '../ui'
import { ProfileView, profileTab } from '../views/profile'
import { profileDataOf } from '../views/public-data'
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
  const [search] = useSearchParams()
  const loaded = usePublic<ProfileData>(handle ? profilePath(handle) : null)
  const member = useMemberControls()
  const tables = useTables()
  const { locale } = useUi()
  const readingLang = useReadingLang(locale)
  const never = readingPrefsOf(tables).never
  const reading = useMemo(() => ({ lang: readingLang, never }), [readingLang, never])
  const now = useNow()
  useTitle(handle ? `@${handle}` : null)

  // The member's own profile changed (a privacy switch, a new name): the copy held this visit is
  // not what the page says now.
  const mine = handle !== null && handle === tables.profile?.handle
  const seq = tables.profile?.seq ?? null
  const lastSeq = useRef(seq)
  useEffect(() => {
    if (lastSeq.current !== seq && mine && handle) forgetPublic(profilePath(handle))
    lastSeq.current = seq
  }, [seq, mine, handle])

  // The page is cached for everyone and a few minutes old; the member's own follow is not. Their
  // click moves the followers count at once, from whatever the page said when it loaded.
  const data = loaded.status === 'ready' ? profileDataOf(loaded.data) : null
  const following = data ? member?.isFollowing(data.profile.id) === true : false
  const atLoad = useRef<{ data: ProfileData; following: boolean } | null>(null)
  if (data && atLoad.current?.data !== data) atLoad.current = { data, following }

  if (!handle || loaded.status === 'missing') return <NotFoundPage />
  if (!data) return <main className="flex-1" aria-busy="true" />
  const shift = (following ? 1 : 0) - (atLoad.current?.following ? 1 : 0)
  const counts = {
    ...data.counts,
    followers: Math.max(0, data.counts.followers + shift),
    // Whom the member follows, their device knows better than a cached page.
    following: mine ? tables.follows.size : data.counts.following,
  }
  return (
    <ProfileView
      data={data}
      tab={profileTab(search.get('tab'), data)}
      member={member}
      reading={reading}
      locale={locale}
      now={now}
      counts={counts}
    />
  )
}
