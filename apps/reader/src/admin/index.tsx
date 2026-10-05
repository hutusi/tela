/**
 * The admin console (ADR 0039), loaded only when someone opens `/admin`: the reader's shell never
 * carries it. Only a member tela-api calls an admin gets past the door; everyone else, and any 403
 * on the way, sees the app's Not found page, so the console's existence says nothing.
 */
import { Route, Routes } from 'react-router'
import { useTables } from '../store/hooks'
import { AdminI18n } from './i18n'
import { AdminNotFound } from './not-found'
import { AdminShell } from './shell'

export default function AdminApp() {
  const profile = useTables().profile
  // No profile yet is a device whose first sync has not landed: not an answer either way.
  if (!profile) return null
  if (!profile.isAdmin) return <AdminNotFound />
  // One route for the Overview and every area, so the frame (its toast, its counts) stays mounted
  // as the operator moves between them.
  return (
    <AdminI18n>
      <Routes>
        <Route path="/:area?" element={<AdminShell />} />
        <Route path="*" element={<AdminNotFound />} />
      </Routes>
    </AdminI18n>
  )
}
