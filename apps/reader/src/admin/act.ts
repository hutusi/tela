/**
 * Acting, as words and rules rather than components: which actions ask first, how a button looks,
 * and what the toast says about an answer. Pure, so the tests read them as they are; `t` is the
 * `admin.shell` translator, passed in.
 */
import {
  ACTION_CONFIRM,
  ACTION_INPUT,
  ADMIN_ACT_ERRORS,
  type AdminActArgs,
  type AdminActError,
  type AdminActionName,
  type AdminActResponse,
  type AdminHistoryEntry,
  type AdminRowBase,
  type AdminUndoResponse,
  isAdminAction,
} from '@tela/shared/admin'

export type Translate = (key: string, values?: Record<string, string | number>) => string

/** Actions that take something away, drawn in `danger` wherever they are offered. */
const DANGER: ReadonlySet<AdminActionName> = new Set([
  'site.hide',
  'claim.reject',
  'claim.remove',
  'code.revoke',
  'hold.cancel',
])

/**
 * A button's look: a taking-away action is `danger` wherever it is; otherwise a row's first
 * action, its likeliest, is the one filled button, as the design draws it.
 */
export function actionLook(action: AdminActionName, index: number): 'primary' | 'danger' | 'ghost' {
  if (DANGER.has(action)) return 'danger'
  return index === 0 ? 'primary' : 'ghost'
}

export type InputKind = (typeof ACTION_INPUT)[keyof typeof ACTION_INPUT]

/** What an action asks before it is sent: its words (unless given), or a yes; null to send now. */
export function promptFor(
  action: AdminActionName,
  args?: AdminActArgs,
): { input: InputKind } | { confirm: true } | null {
  const input = (ACTION_INPUT as Partial<Record<AdminActionName, InputKind>>)[action]
  if (input && !args) return { input }
  if ((ACTION_CONFIRM as readonly AdminActionName[]).includes(action)) return { confirm: true }
  return null
}

/**
 * What a confirmation asks: of one target, or of `n` at once. A bulk question in the singular
 * ("Revoke this code?") over three checked codes would be a yes to something else.
 */
export function confirmWords(
  t: Translate,
  prompt: { action: AdminActionName; ids: readonly string[] },
) {
  const n = prompt.ids.length
  return n > 1 ? t(`confirmMany.${prompt.action}`, { n }) : t(`confirm.${prompt.action}`)
}

/**
 * The bulk actions to offer for the checked rows: the area's, each only while at least one checked
 * row takes it now (the server lists what applies to each row). Revoke means nothing to a hold, and
 * a retry nothing to a lease.
 */
export function bulkOffer(
  bulk: readonly AdminActionName[],
  checked: readonly AdminRowBase[],
): AdminActionName[] {
  return bulk.filter((action) => checked.some((row) => row.actions.includes(action)))
}

/** The checked rows a bulk action is sent for: those it applies to, never the rest. */
export function bulkTargets(action: AdminActionName, checked: readonly AdminRowBase[]): string[] {
  return checked.filter((row) => row.actions.includes(action)).map((row) => row.id)
}

function errorWords(t: Translate, error: AdminActError | string): string {
  return (ADMIN_ACT_ERRORS as readonly string[]).includes(error)
    ? t(`errors.${error}`)
    : t('errors.failed')
}

/**
 * The toast after an action: what it did and to what (the row's title for one, a count for
 * several), what did not happen and why when only some did, the reason alone when none did.
 */
export function actMessage(
  t: Translate,
  outcome: {
    action: AdminActionName
    response: AdminActResponse | null
    /** The title of a row it acted on, as the ledger showed it; null for one it did not show. */
    titleOf: (id: string) => string | null
  },
): string {
  const { action, response, titleOf } = outcome
  if (!response) return t('errors.failed')
  const { done, failed } = response
  const words = t(`actions.${action}.done`)
  const first = failed[0]
  if (done.length === 0) return first ? errorWords(t, first.error) : t('errors.not_applicable')
  if (first) {
    const partial = t('toast.partial', {
      done: done.length,
      failed: failed.length,
      reason: errorWords(t, first.error),
    })
    return t('toast.one', { action: words, target: partial })
  }
  if (done.length === 1) {
    const target = titleOf(done[0] ?? '')
    return target ? t('toast.one', { action: words, target }) : words
  }
  return t('toast.many', { action: words, n: done.length })
}

/** The toast after an undo. */
export function undoMessage(t: Translate, response: AdminUndoResponse | null): string {
  if (!response) return t('errors.failed')
  if ('restored' in response) return t('toast.undone')
  return response.error === 'changed_since' ? t('toast.changedSince') : t('errors.not_found')
}

/** What an audit entry did, in its action's past tense: History's words and the Overview's. */
export function historyWords(
  t: Translate,
  entry: Pick<AdminHistoryEntry, 'action' | 'undid'>,
): string {
  const { action, undid } = entry
  if (action === 'undo') {
    return undid ? t('ledger.undo', { action: t(`actions.${undid}.done`) }) : t('toast.undone')
  }
  if (action === 'admin.grant') return t('audit.grant')
  if (action === 'admin.ungrant') return t('audit.ungrant')
  // A newer server's action this build has no words for: its name beats a missing message.
  return isAdminAction(action) ? t(`actions.${action}.done`) : String(action)
}
