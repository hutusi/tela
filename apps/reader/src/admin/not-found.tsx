/**
 * The app's own Not found, header and all, exactly as any other missing page shows it: to anyone
 * who is not an admin, the console is a page that does not exist (ADR 0039).
 */
import { AppHeader } from '../components/app-header'
import { NotFoundPage } from '../pages/not-found'

export function AdminNotFound() {
  return (
    <>
      <AppHeader />
      <NotFoundPage />
    </>
  )
}
