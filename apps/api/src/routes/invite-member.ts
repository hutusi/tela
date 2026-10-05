/**
 * Inviting one address, the operator's way (ADR 0034): `bun run admin invite <email>` through the
 * token route, and the console's "Invite by email" (ADR 0039). Both come here, so the two cannot
 * drift apart on what an invitation is.
 */
import { inviteAddress } from '@tela/data'
import type { Auth } from '../auth'
import type { ApiDeps } from '../deps'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type Invited = {
  userId: string
  /** False when the address already had an account, which was only mailed a fresh code. */
  created: boolean
}

/**
 * Create the account for `input` and mail it a sign-in code; null when it is not an address. The
 * account passes the same gate as everyone's: the operator's invitation to the address, an hour
 * long, is written first, and better-auth's `user.create.before` claims it as it would anyone's.
 * The internal adapter runs outside any endpoint, where the gate finds no context, and a missing
 * context grants nothing: the invitation is what admits it. An address that has an account is
 * only mailed a fresh code, and given no invitation it could keep.
 */
export async function inviteMember(
  deps: Pick<ApiDeps, 'db' | 'clock'>,
  auth: Auth,
  input: string,
): Promise<Invited | null> {
  const email = input.trim().toLowerCase()
  if (!EMAIL.test(email)) return null
  const ctx = await auth.$context
  const existing = await ctx.internalAdapter.findUserByEmail(email)
  let user = existing?.user
  if (!user) {
    await inviteAddress(deps.db, { email, now: deps.clock.now() })
    user = await ctx.internalAdapter.createUser(
      { email, name: '', emailVerified: false },
      { method: 'admin' },
    )
  }
  await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
  return { userId: user.id, created: !existing }
}
