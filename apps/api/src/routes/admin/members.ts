/**
 * People and Invitations (ADR 0039), Reports (ADR 0059), and Apps (ADR 0064). An admin sees a
 * member's card and account basics, never their reading: what they subscribe to, read, like,
 * highlight, recommend or follow stays theirs. A report shows what anyone could see on the page it
 * was made from. An app's record counts who connected it, never names them.
 */
import { Hono } from 'hono'
import type { Auth } from '../../auth'
import type { ApiDeps } from '../../deps'
import type { AdminEnv, AdminModule } from './framework'
import { appActions, appInverses, appRoutes } from './members/apps'
import { inviteActions, inviteInverses, inviteRoutes } from './members/invites'
import { peopleActions, peopleInverses, peopleRoutes } from './members/people'
import { reportActions, reportInverses, reportRoutes } from './members/reports'

/**
 * `auth` reaches the actions through their context (`ActContext.auth`): inviting an address makes
 * its account through better-auth, as the token route does.
 */
export function membersModule(deps: ApiDeps, auth: Auth): AdminModule {
  void auth
  const routes = new Hono<AdminEnv>()
  routes.route('/', peopleRoutes(deps))
  routes.route('/', inviteRoutes(deps))
  routes.route('/', reportRoutes(deps))
  routes.route('/', appRoutes(deps))
  return {
    routes,
    actions: { ...peopleActions, ...inviteActions, ...reportActions, ...appActions },
    inverses: { ...peopleInverses, ...inviteInverses, ...reportInverses, ...appInverses },
  }
}
