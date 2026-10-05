/**
 * Claims, Sites, Feeds and Discover: the blogs Tela knows, and the queues about them (ADR 0039).
 * The reads are in `library/reads.ts`; each kind of target's actions and their undos beside it.
 */
import type { ApiDeps } from '../../deps'
import type { AdminModule } from './framework'
import { claimActions, claimInverses } from './library/claims'
import { feedActions, feedInverses } from './library/feeds'
import { libraryReads } from './library/reads'
import { siteActions, siteInverses } from './library/sites'

export { DOORS_SAY, siteIdOf } from './library/common'

export function libraryModule(deps: ApiDeps): AdminModule {
  return {
    routes: libraryReads(deps),
    actions: { ...siteActions, ...claimActions, ...feedActions },
    inverses: { ...siteInverses, ...claimInverses, ...feedInverses },
  }
}
