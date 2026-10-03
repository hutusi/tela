import { useMemo } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { useMemberControls } from '../lib/member'
import { readingPrefsOf } from '../lib/prefs'
import { safeDecode } from '../lib/safe-decode'
import { useTitle } from '../lib/title'
import { usePublic } from '../lib/use-public'
import { useConfirmedFollowees, useNow, useReadingLang, useStore, useTables } from '../store/hooks'
import { useUi } from '../ui'
import { ProfileView, profileTab } from '../views/profile'
import { profileDataOf } from '../views/public-data'
import type { ProfileData } from '../views/types'
import { NotFoundPage } from './not-found'

/**
 * `/@handle`: the first segment is the literal "@handle"; anything else, one that does not decode
 * included (`/@%`), is not a profile. The edge asks this of every `/@*` too.
 */
export function handleFrom(pathname: string): string | null {
  const segment = safeDecode(pathname.split('/')[1] ?? '') ?? ''
  const handle = segment.startsWith('@') ? segment.slice(1).toLowerCase() : ''
  return /^[a-z0-9_]{1,30}$/.test(handle) && pathname.split('/').length === 2 ? handle : null
}

export const profilePath = (handle: string) => `/api/v1/public/profiles/${handle}`

/**
 * Whether each copy of a profile counts the member's follow, as far as the device could tell, and
 * which member that was: another account signed in without a reload asks again for itself.
 */
const countedFollowing = new WeakMap<ProfileData, { owner: string; counted: boolean }>()

export function ProfilePage() {
  const handle = handleFrom(useLocation().pathname)
  const [search] = useSearchParams()
  const loaded = usePublic<ProfileData>(handle ? profilePath(handle) : null)
  const member = useMemberControls()
  const { store } = useStore()
  const tables = useTables()
  const { locale } = useUi()
  const readingLang = useReadingLang(locale)
  const never = readingPrefsOf(tables).never
  const reading = useMemo(() => ({ lang: readingLang, never }), [readingLang, never])
  const now = useNow()
  useTitle(handle ? `@${handle}` : null)

  // The member's own profile is forgotten when it changes, wherever they are (`Routed`).
  const mine = handle !== null && handle === tables.profile?.handle

  // The page is cached for everyone and a few minutes old; the member's own follow is not. Their
  // click moves the followers count at once, from whatever this copy of the page counted: each
  // copy is taken to count the follow the server had when it was first shown (the confirmed
  // follows, not the prediction). A copy from the browser's cache after the click is no newer than
  // that, and once the server has the follow, the app forgets the copies and fetches past the
  // cache (`onFollowsConfirmed`), so a fresh one counts the follow itself.
  // Only for a member whose rows the device holds: before the first pull (a boot, a sign-in) it
  // knows of no follow, and a baseline taken then counts a follow the copy already has twice. A
  // guest, or a member signed out without a reload, sees the page's own count. (A copy fetched in
  // the few milliseconds between the server applying a follow and the pull bringing it back counts
  // it twice until the copy is forgotten.)
  const data = loaded.status === 'ready' ? profileDataOf(loaded.data) : null
  const following = data ? member?.isFollowing(data.profile.id) === true : false
  const confirmed = useConfirmedFollowees()
  const owner = member && store.hasData ? member.userId : null
  if (data && owner && countedFollowing.get(data)?.owner !== owner) {
    countedFollowing.set(data, { owner, counted: confirmed.split(',').includes(data.profile.id) })
  }

  if (!handle || loaded.status === 'missing') return <NotFoundPage />
  if (!data) return <main className="flex-1" aria-busy="true" />
  const base = countedFollowing.get(data)
  const shift = owner && base?.owner === owner ? (following ? 1 : 0) - (base.counted ? 1 : 0) : 0
  const counts = data.counts && {
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
