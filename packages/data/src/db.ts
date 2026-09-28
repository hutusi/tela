import type { Db } from '@tela/platform'
import type * as schema from './schema'

/** Tela's database, whatever runs it: D1 in production, libSQL in tests and the exit path. */
export type TelaDb = Db<typeof schema>
