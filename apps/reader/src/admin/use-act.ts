/**
 * Acting from a ledger: ask first where the action asks (a yes, or its words), send it, say what
 * happened in the toast with its undo, and have everything load again. Confirmations and questions
 * are inline, in the record panel, the bulk bar or beside the search, never `window.confirm`.
 */
import type { AdminActArgs, AdminActionName } from '@tela/shared/admin'
import { useCallback, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { actMessage, promptFor } from './act'
import { adminAct, NotAdmin } from './api'
import { useAdmin } from './context'

/** Where a question is asked: in the open record, the bulk bar, or beside the search. */
export type PromptPlace = 'record' | 'bulk' | 'create'

/** An action waiting on the operator's yes or words. */
export type Prompt = {
  action: AdminActionName
  ids: string[]
  where: PromptPlace
  /** Words already given (a record's own act with arguments): only the yes is asked. */
  args?: AdminActArgs
}

export type Acted = { action: AdminActionName; ids: string[]; done: string[] }

export function useAdminAct(options: {
  /** A row's title as the ledger shows it, for the toast. */
  titleOf: (id: string) => string | null
  /** After an answer, before the reload it starts: the ledger notes where the selection was. */
  onActed?: (acted: Acted) => void
}) {
  const admin = useAdmin()
  const t = useTranslations('admin.shell')
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [busy, setBusy] = useState(false)
  // Busy as of now, not as of the last render: two clicks in one frame both see `busy` false.
  const busyRef = useRef(false)
  const latest = useRef(options)
  latest.current = options

  /**
   * Send an action, unless one is already out: one at a time, so a second click on a topic chip
   * or a toggle never races the first and lands on the state from before it. Says whether it went.
   */
  const run = useCallback(
    async (action: AdminActionName, ids: string[], args?: AdminActArgs) => {
      if (busyRef.current) return false
      busyRef.current = true
      setPrompt(null)
      setBusy(true)
      try {
        const response = await adminAct({ action, ids, ...(args ? { args } : {}) })
        const titleOf = (id: string) =>
          latest.current.titleOf(id) ?? (id === '' ? (args?.code ?? args?.email ?? null) : null)
        admin.say(actMessage(t, { action, response, titleOf }), {
          undo: response?.undo?.group ?? null,
          error: !response || response.done.length === 0,
        })
        if (response) latest.current.onActed?.({ action, ids, done: response.done })
      } catch (error) {
        if (error instanceof NotAdmin) admin.deny()
        else admin.say(t('errors.failed'), { error: true })
      } finally {
        busyRef.current = false
        setBusy(false)
        admin.changed()
      }
      return true
    },
    [admin, t],
  )

  /** Act, or ask first; nothing while an action is out. Says whether it went or asked. */
  const request = useCallback(
    (action: AdminActionName, ids: string[], where: PromptPlace, args?: AdminActArgs) => {
      if (busyRef.current) return false
      if (promptFor(action, args)) setPrompt({ action, ids, where, ...(args ? { args } : {}) })
      else void run(action, ids, args)
      return true
    },
    [run],
  )

  return { prompt, setPrompt, busy, request, run }
}
