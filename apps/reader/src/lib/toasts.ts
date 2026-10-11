/**
 * The reader's one toast: what the last action did, said once at the foot of the page, with an
 * action (Undo) while it can be taken back. One at a time: a newer message replaces the one
 * showing, and takes its own time. A toast with an action stays long enough to use it.
 *
 * A module store rather than context, so any component can say something without being handed a
 * function, and the one `<Toast />` in the app shell renders it.
 */
import { useSyncExternalStore } from 'react'

/** How long a message stays (Tela v5). */
export const TOAST_MS = 2600
/** How long a message with an action stays: the window in which Undo can be pressed. */
export const UNDO_MS = 5000
/**
 * How long a change that offers Undo is held on the device before it is sent (`LocalStore.mutate`
 * with `holdMs`): longer than the toast, so an Undo pressed while it shows always finds the change
 * still held, and the server never hears of it.
 */
export const UNDO_HOLD_MS = UNDO_MS + 1000

export type ToastAction = { label: string; run: () => void }
export type ToastMessage = { id: number; text: string; action: ToastAction | null }

let current: ToastMessage | null = null
let next = 1
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Say `text`, with `action` if there is one. Returns its id, for `dismissToast`. */
export function showToast(text: string, action?: ToastAction): number {
  const id = next++
  current = { id, text, action: action ?? null }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => dismissToast(id), action ? UNDO_MS : TOAST_MS)
  emit()
  return id
}

/** Take the toast down: the one with `id` only, if given, so a stale timer takes nothing newer. */
export function dismissToast(id?: number): void {
  if (current === null || (id !== undefined && current.id !== id)) return
  current = null
  if (timer) clearTimeout(timer)
  timer = null
  emit()
}

/** Run the toast's action, once, and take it down. */
export function runToastAction(id: number): void {
  if (current?.id !== id || current.action === null) return
  const { run } = current.action
  dismissToast(id)
  run()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The toast showing now, if any. */
export const currentToast = (): ToastMessage | null => current
const none = () => null

export function useToast(): ToastMessage | null {
  return useSyncExternalStore(subscribe, currentToast, none)
}
