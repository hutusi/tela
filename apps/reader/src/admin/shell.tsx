/** The console's frame: the sidebar, and the area the address names. Built by the shell slice. */
import type { AdminArea } from '@tela/shared/admin'

export function AdminShell({ area }: { area?: AdminArea }) {
  void area
  return null
}
