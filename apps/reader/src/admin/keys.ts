/**
 * The console's keys (the design's 2a board): j and k move, x checks, Enter or o opens, 1 to 3
 * act, u undoes, / searches, Esc closes the record or clears the checks. The decision is pure, so
 * the tests say what a key does in each state; the ledger's one listener applies it, reading the
 * state it acts on when the key is pressed (AGENTS gotchas), as `reading.tsx` does.
 */

/** A key event as far as the console asks about it. */
export type KeyLike = {
  key: string
  defaultPrevented: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  /** The target is a field: typing there is never a shortcut. */
  inField: boolean
  /** The target is a button, link or check box, which Enter or Space already press. */
  onControl: boolean
}

/**
 * Whether the console takes a key. A key typed into a field is the field's, except Escape, which
 * leaves it (so the next key is a shortcut again). Enter or Space on a button is the button's:
 * the confirmation strip focuses its Yes, and Enter there must say yes, not open a row.
 */
export function keyDisposition(e: KeyLike): 'skip' | 'blur' | 'handle' {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return 'skip'
  if (e.inField) return e.key === 'Escape' ? 'blur' : 'skip'
  if (e.onControl && (e.key === 'Enter' || e.key === ' ')) return 'skip'
  return 'handle'
}

/** Read off a DOM event's target. */
export function keyLike(e: KeyboardEvent): KeyLike {
  const target = e.target instanceof Element ? e.target : null
  return {
    key: e.key,
    defaultPrevented: e.defaultPrevented,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    // A row's check box is a control, not a field: j and k go on working once it has been clicked.
    inField: !!target?.closest(
      'input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable]:not([contenteditable="false"])',
    ),
    onControl: !!target?.closest('button, a[href], summary, [role="button"], input'),
  }
}

export type LedgerCommand =
  | { type: 'move'; step: 1 | -1 }
  | { type: 'check' }
  | { type: 'open' }
  | { type: 'act'; index: 0 | 1 | 2 }
  | { type: 'undo' }
  | { type: 'search' }
  | { type: 'cancelPrompt' }
  | { type: 'close' }
  | { type: 'clearChecks' }

export type KeyState = {
  /** Rows the ledger shows. */
  rows: number
  /** A record is open. */
  open: boolean
  /** Rows checked for a bulk action. */
  checked: number
  /** A confirmation or a question is waiting for an answer. */
  prompt: boolean
}

/**
 * What a key does now, or null when it does nothing (so the browser keeps it). Esc takes back the
 * nearest thing first: a waiting question, then the open record, then the checks.
 */
export function ledgerCommand(key: string, state: KeyState): LedgerCommand | null {
  const k = key.length === 1 ? key.toLowerCase() : key
  switch (k) {
    case 'u':
      return { type: 'undo' }
    case '/':
      return { type: 'search' }
    case 'Escape':
      if (state.prompt) return { type: 'cancelPrompt' }
      if (state.open) return { type: 'close' }
      return state.checked > 0 ? { type: 'clearChecks' } : null
  }
  if (state.rows === 0) return null
  switch (k) {
    case 'j':
    case 'ArrowDown':
      return { type: 'move', step: 1 }
    case 'k':
    case 'ArrowUp':
      return { type: 'move', step: -1 }
    case 'x':
      return { type: 'check' }
    case 'Enter':
    case 'o':
      return { type: 'open' }
    case '1':
      return { type: 'act', index: 0 }
    case '2':
      return { type: 'act', index: 1 }
    case '3':
      return { type: 'act', index: 2 }
  }
  return null
}

/** The row a step lands on, held at the ends; from nowhere, j starts at the top and k at the end. */
export function stepTo(ids: readonly string[], from: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null
  const at = from === null ? -1 : ids.indexOf(from)
  if (at === -1) return (step === 1 ? ids[0] : ids[ids.length - 1]) ?? null
  return ids[Math.min(ids.length - 1, Math.max(0, at + step))] ?? null
}
