/**
 * The admin console (ADR 0039), loaded only when someone opens `/admin`: the reader's shell never
 * carries it. Only a member tela-api calls an admin gets past the door; everyone else, and any 403
 * on the way, sees the app's Not found page, so the console's existence says nothing.
 */
import { Route, Routes } from 'react-router'
import { NotFoundPage } from '../pages/not-found'
import { useTables } from '../store/hooks'
import { AdminI18n } from './i18n'
import { AdminShell } from './shell'

export default function AdminApp() {
  const profile = useTables().profile
  if (!profile?.isAdmin) return <NotFoundPage />
  return (
    <AdminI18n>
      <Routes>
        <Route path="/" element={<AdminShell area="overview" />} />
        <Route path="/:area" element={<AdminShell />} />
      </Routes>
    </AdminI18n>
  )
}
