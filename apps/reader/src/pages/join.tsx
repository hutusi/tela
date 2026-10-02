/**
 * `/join`: the front page with the join sheet over it (ADRs 0034, 0035), where a member's invite
 * link (`/join?code=…`) and the header's Join, before the script runs, both land. The code is read
 * once and taken out of the address bar. The page stays in the SPA, never rendered at the edge, so
 * a code in its address never reaches a Worker's logs. Closing the sheet leaves for `/`.
 */
import { useEffect, useRef } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { useFrontDoor } from '../components/front-door'
import { providerError, takeInvite } from '../lib/use-sign-in'
import { useSession } from '../session'
import { LandingPage } from './landing'

export function JoinPage() {
  const { status } = useSession()
  const door = useFrontDoor()
  const navigate = useNavigate()
  const go = useRef(navigate)
  go.current = navigate
  const [search] = useSearchParams()
  const member = status === 'member'

  useEffect(() => {
    if (member) return
    const typed = search.get('code')
    // Back from Google or GitHub, refused: the code it carried was kept for this tab.
    const error = search.get('error')
    if (typed !== null || error !== null) {
      window.history.replaceState(window.history.state, '', '/join')
    }
    const code = typed ?? (error !== null ? takeInvite() : null)
    door?.({
      mode: 'join',
      ...(code ? { code } : {}),
      ...(error ? { error: providerError(error) } : {}),
      onClose: () => go.current('/', { replace: true }),
    })
  }, [search, door, member])

  // Already in: there is nothing to join.
  if (member) return <Navigate to="/reading" replace />
  return <LandingPage />
}
