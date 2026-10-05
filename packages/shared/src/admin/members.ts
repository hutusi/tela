/**
 * People and Invitations. An admin sees a member's public card and account basics, never what
 * they read, subscribe to, like or highlight (ADR 0039).
 */
import type { AdminHistoryEntry, AdminPerson, AdminRowBase } from './common'

/** How someone got in. */
export type AdminInvitedBy =
  | { kind: 'member'; by: AdminPerson | null; code: string }
  | { kind: 'code'; code: string }
  | { kind: 'operator' }

export type AdminPersonRow = AdminRowBase & {
  userId: string
  handle: string
  name: string | null
  email: string
  avatar: string | null
  isAdmin: boolean
  /** Ways in besides the mailed code: `credential` (a password), `google`, `github`. */
  signIn: string[]
  joinedAt: number
  invitedBy: AdminInvitedBy | null
  /** Blogs they have claimed. */
  blogs: number
  /** Of their five codes, how many admitted someone. */
  invitesUsed: number
  sessions: number
  lastSeenAt: number | null
}

export type AdminPersonDetail = {
  person: AdminPersonRow
  bio: string | null
  blogs: {
    siteId: number
    title: string | null
    homeUrl: string
    listing: string
    readerCount: number
  }[]
  /** Their codes: who each admitted, and which are still open. */
  codes: AdminCodeRow[]
  history: AdminHistoryEntry[]
}

export type AdminCodeRow = AdminRowBase & {
  type: 'code'
  code: string
  /** Null for the operator's own. */
  createdBy: AdminPerson | null
  maxUses: number
  used: number
  /** Live holds: addresses waiting on a sign-in code with it. */
  holds: number
  createdAt: number
  revokedAt: number | null
  /** Who joined with it, newest first, up to ten. */
  joined: AdminPerson[]
}

export type AdminHoldRow = AdminRowBase & {
  type: 'hold'
  redemptionId: number
  email: string
  /** Null for the operator's invitation to one address. */
  code: string | null
  codeOwner: AdminPerson | null
  expiresAt: number
  createdAt: number
}

export type AdminInviteRow = AdminCodeRow | AdminHoldRow

export type AdminInviteDetail = {
  invite: AdminInviteRow
  history: AdminHistoryEntry[]
}
