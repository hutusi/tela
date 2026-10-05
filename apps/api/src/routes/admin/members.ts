/**
 * People and Invitations (ADR 0039). An admin sees a member's card and account basics, never their
 * reading: what they subscribe to, read, like, highlight, recommend or follow stays theirs.
 */
import { Hono } from 'hono'
import type { Auth } from '../../auth'
import type { ApiDeps } from '../../deps'
import type { AdminEnv, AdminModule } from './framework'
import { inviteActions, inviteInverses, inviteRoutes } from './members/invites'
import { peopleActions, peopleRoutes } from './members/people'

/**
 * `auth` reaches the actions through their context (`ActContext.auth`): inviting an address makes
 * its account through better-auth, as the token route does.
 */
export function membersModule(deps: ApiDeps, auth: Auth): AdminModule {
  void auth
  const routes = new Hono<AdminEnv>()
  routes.route('/', peopleRoutes(deps))
  routes.route('/', inviteRoutes(deps))
  return {
    routes,
    actions: { ...peopleActions, ...inviteActions },
    inverses: inviteInverses,
  }
}
