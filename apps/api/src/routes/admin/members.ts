/** People and Invitations. An admin sees a member's card and account basics, never their reading. */
import { Hono } from 'hono'
import type { Auth } from '../../auth'
import type { ApiDeps } from '../../deps'
import type { AdminEnv, AdminModule } from './framework'

export function membersModule(deps: ApiDeps, auth: Auth): AdminModule {
  void deps
  void auth
  const routes = new Hono<AdminEnv>()
  return { routes, actions: {}, inverses: {} }
}
