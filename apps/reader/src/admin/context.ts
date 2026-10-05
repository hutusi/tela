/**
 * What the console's frame shares with whatever area it shows: a version that moves after every
 * action or undo (so the list, the open record and the sidebar's counts load again), the one undo
 * toast, and the way to say the member is no admin after all.
 */
import { createContext, useContext } from 'react'

export type Toast = {
  /** New for every message, so a repeat of the same words still restarts its six seconds. */
  id: number
  text: string
  /** The group to post to `/undo`, while the action can be taken back. */
  undo: string | null
  error: boolean
}

export type AdminContextValue = {
  version: number
  /** Something changed on the server: load again. */
  changed(): void
  toast: Toast | null
  say(text: string, options?: { undo?: string | null; error?: boolean }): void
  dismiss(): void
  /** Take back the action the toast shows, if it can be. */
  undo(): void
  /** A 403: the console is a page that is not (ADR 0039). */
  deny(): void
}

export const AdminContext = createContext<AdminContextValue | null>(null)

export function useAdmin(): AdminContextValue {
  const value = useContext(AdminContext)
  if (!value) throw new Error('useAdmin outside AdminShell')
  return value
}
