/**
 * The console's one toast, as a sequence of numbered messages. An undo's answer is a reply to the
 * toast it undid, and replaces only that toast: an undo can take long enough for a newer action's
 * toast to come first, and a late answer over it would take that toast's words and its Undo away.
 * Pure, so the tests read a run of events as it is; the shell keeps the state in a reducer.
 */

export type Toast = {
  /** New for every message, so a repeat of the same words still restarts its six seconds. */
  id: number
  text: string
  /** The group to post to `/undo`, while the action can be taken back. */
  undo: string | null
  error: boolean
}

export type ToastState = {
  /** The last number a message was given. Dismissing a toast keeps it: only a message moves it on. */
  seq: number
  toast: Toast | null
}

export type ToastEvent =
  /** A new message: an action's answer, or anything else the console says. */
  | { type: 'say'; text: string; undo?: string | null; error?: boolean }
  /** Toast `id`'s undo is out: there is nothing left on it to take back. */
  | { type: 'undoing'; id: number }
  /** The answer to toast `to`'s undo: a message only while nothing has been said since. */
  | { type: 'reply'; to: number; text: string; error: boolean }
  /** Toast `id`'s time is up (or, with no id, whatever is shown goes). */
  | { type: 'dismiss'; id?: number | undefined }

export const NO_TOAST: ToastState = { seq: 0, toast: null }

export function toastReducer(state: ToastState, event: ToastEvent): ToastState {
  switch (event.type) {
    case 'say': {
      const id = state.seq + 1
      const toast = { id, text: event.text, undo: event.undo ?? null, error: event.error ?? false }
      return { seq: id, toast }
    }
    case 'undoing': {
      const toast = state.toast
      if (toast?.id !== event.id || toast.undo === null) return state
      return { ...state, toast: { ...toast, undo: null } }
    }
    case 'reply': {
      if (state.seq !== event.to) return state
      return toastReducer(state, { type: 'say', text: event.text, error: event.error })
    }
    case 'dismiss': {
      if (state.toast === null) return state
      if (event.id !== undefined && state.toast.id !== event.id) return state
      return { ...state, toast: null }
    }
  }
}
