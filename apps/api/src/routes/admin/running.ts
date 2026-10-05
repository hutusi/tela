/** Translation, System and the Overview: how Tela is running, and what it costs. */
import { Hono } from 'hono'
import type { ApiDeps } from '../../deps'
import type { AdminEnv, AdminModule } from './framework'

export function runningModule(deps: ApiDeps): AdminModule {
  void deps
  const routes = new Hono<AdminEnv>()
  return { routes, actions: {}, inverses: {} }
}
