/**
 * Who a web call acts for, as the rules both surfaces share take it (ADR 0065): the session's
 * member, exempt from the member limits while an admin. An app's calls never come through here:
 * they act with `exempt: false` whoever the member is (ADR 0064).
 */
import { type Actor, memberStanding, type TelaDb } from '@tela/data'
import type { Context } from 'hono'
import type { ApiEnv } from './app'

/**
 * The web's actor. The member check reads `is_admin` beside the standing it reads for every call
 * that writes, so those cost nothing more; any other call reads it here, once.
 */
export async function webActor<E extends ApiEnv>(c: Context<E>, db: TelaDb): Promise<Actor> {
  const vars = c as unknown as Context<ApiEnv>
  const known = vars.get('actor')
  if (known) return known
  const member = vars.get('member')
  const actor = { userId: member.id, exempt: (await memberStanding(db, member.id)).admin }
  vars.set('actor', actor)
  return actor
}
