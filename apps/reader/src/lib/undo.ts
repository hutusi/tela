/**
 * Undo for a change held on the device (ADR 0046): the toast that offers it owns the hold. While
 * the toast shows, paused or not, the change stays held, and Undo takes it back before tela-api
 * hears of it; once the toast goes without its Undo, the change goes too. The store's own timer
 * (`UNDO_HOLD_MS`) is only the backstop.
 */
import type { HighlightRow } from '@tela/sync'
import type { LocalStore, MutationInput } from '../store/local'
import { newId } from './id'
import { showToast } from './toasts'

/**
 * Say `text` with an Undo for the changes `held` (made with `holdMs`). Undo takes them back while
 * they are held; pressed after they went anyway (the tab was hidden meanwhile, or the backstop ran
 * out), it calls `late` to undo them another way. Once the tab holds another account, it does
 * nothing: nothing of this one's is there to take back.
 */
export function offerUndo(
  store: Pick<LocalStore, 'epoch' | 'retract' | 'release'>,
  text: string,
  label: string,
  held: readonly string[],
  late: () => void,
): number {
  const epoch = store.epoch
  return showToast(text, {
    label,
    run: () => {
      if (store.epoch !== epoch || store.retract(...held)) return
      late()
    },
    settle: () => store.release(...held),
  })
}

/**
 * The most posts an Undo marks unread one by one, once the mark-all it takes back has been sent:
 * past that, one press would queue a push of hundreds.
 */
export const UNDO_UNREAD_MAX = 200

/**
 * Undo a mark-all, or Today's reads, after they went to the server: each post they read, marked
 * unread on its own and later than `after`. False, and nothing made, past `UNDO_UNREAD_MAX`.
 */
export function unreadAgain(
  store: Pick<LocalStore, 'mutateMany'>,
  ids: readonly number[],
  after: number,
): boolean {
  if (ids.length > UNDO_UNREAD_MAX) return false
  store.mutateMany(
    ids.map((articleId) => ({ type: 'markUnread', articleId }) as const),
    { after },
  )
  return true
}

/**
 * Undo a removal after it went to the server: the same passage and note again, under a new id,
 * since a deleted highlight's id stays deleted.
 */
export function highlightAgain(row: HighlightRow, id: string = newId()): MutationInput {
  const { articleId, contentKey, side, lang, leafId, start, end, quote, prefix, suffix, note } = row
  return {
    type: 'putHighlight',
    id,
    ...{ articleId, contentKey, side, lang, leafId, start, end, quote, prefix, suffix, note },
  }
}
