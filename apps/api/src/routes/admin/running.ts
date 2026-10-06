/**
 * Translation, System and the Overview: how Tela is running, and what it costs (ADR 0039). Reads
 * only, but for what the System area does to dead work: retry a dead letter, dismiss one (the one
 * undo here), or let a lease that is backing off be claimed now.
 */
import { Hono } from 'hono'
import type { ApiDeps } from '../../deps'
import type { AdminEnv, AdminModule } from './framework'
import { overviewRoutes } from './running/overview'
import { systemActions, systemInverses, systemRoutes } from './running/system'
import { translationRoutes } from './running/translation'

export function runningModule(deps: ApiDeps): AdminModule {
  const routes = new Hono<AdminEnv>()
  routes.route('/', overviewRoutes(deps))
  routes.route('/', translationRoutes(deps))
  routes.route('/', systemRoutes(deps))
  return { routes, actions: { ...systemActions }, inverses: { ...systemInverses } }
}
