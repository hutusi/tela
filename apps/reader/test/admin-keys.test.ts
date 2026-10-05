/** The admin console's keys (the design's 2a): which key does what, in which state. */
import { describe, expect, test } from 'bun:test'
import {
  type KeyLike,
  type KeyState,
  keyDisposition,
  ledgerCommand,
  scrollTarget,
  stepTo,
} from '../src/admin/keys'

const press = (key: string, more: Partial<KeyLike> = {}): KeyLike => ({
  key,
  defaultPrevented: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  inField: false,
  onControl: false,
  ...more,
})

const LIST: KeyState = { rows: 4, open: false, checked: 0, prompt: false, checkable: true }

describe('whether the console takes a key', () => {
  test('a plain key on the page is the console’s', () => {
    expect(keyDisposition(press('j'))).toBe('handle')
    expect(keyDisposition(press('1', { onControl: true }))).toBe('handle')
  })

  test('a key someone else handled, or a shortcut of the browser’s, is not', () => {
    expect(keyDisposition(press('j', { defaultPrevented: true }))).toBe('skip')
    expect(keyDisposition(press('k', { metaKey: true }))).toBe('skip')
    expect(keyDisposition(press('x', { ctrlKey: true }))).toBe('skip')
    expect(keyDisposition(press('u', { altKey: true }))).toBe('skip')
  })

  test('typing in a field is typing, and Esc leaves the field', () => {
    expect(keyDisposition(press('j', { inField: true }))).toBe('skip')
    expect(keyDisposition(press('/', { inField: true }))).toBe('skip')
    expect(keyDisposition(press('Escape', { inField: true }))).toBe('blur')
  })

  test('Enter and Space on a button press the button', () => {
    expect(keyDisposition(press('Enter', { onControl: true }))).toBe('skip')
    expect(keyDisposition(press(' ', { onControl: true }))).toBe('skip')
    expect(keyDisposition(press('Escape', { onControl: true }))).toBe('handle')
  })
})

describe('what a key does', () => {
  test('j and k, or the arrows, move', () => {
    expect(ledgerCommand('j', LIST)).toEqual({ type: 'move', step: 1 })
    expect(ledgerCommand('ArrowDown', LIST)).toEqual({ type: 'move', step: 1 })
    expect(ledgerCommand('k', LIST)).toEqual({ type: 'move', step: -1 })
    expect(ledgerCommand('ArrowUp', LIST)).toEqual({ type: 'move', step: -1 })
    // Caps lock, or Shift, is still j.
    expect(ledgerCommand('J', LIST)).toEqual({ type: 'move', step: 1 })
  })

  test('x checks, Enter or o opens, 1 to 3 act', () => {
    expect(ledgerCommand('x', LIST)).toEqual({ type: 'check' })
    expect(ledgerCommand('Enter', LIST)).toEqual({ type: 'open' })
    expect(ledgerCommand('o', LIST)).toEqual({ type: 'open' })
    expect(ledgerCommand('1', LIST)).toEqual({ type: 'act', index: 0 })
    expect(ledgerCommand('2', LIST)).toEqual({ type: 'act', index: 1 })
    expect(ledgerCommand('3', LIST)).toEqual({ type: 'act', index: 2 })
    expect(ledgerCommand('4', LIST)).toBeNull()
  })

  test('x checks nothing where the area has no bulk action', () => {
    expect(ledgerCommand('x', { ...LIST, checkable: false })).toBeNull()
  })

  test('u undoes and / searches, even with nothing listed', () => {
    const empty = { ...LIST, rows: 0 }
    expect(ledgerCommand('u', empty)).toEqual({ type: 'undo' })
    expect(ledgerCommand('/', empty)).toEqual({ type: 'search' })
    expect(ledgerCommand('j', empty)).toBeNull()
    expect(ledgerCommand('1', empty)).toBeNull()
    expect(ledgerCommand('Enter', empty)).toBeNull()
  })

  test('1 to 3 act on an open record even with nothing listed', () => {
    // A record no filter lists (a rejected claim) opens from its detail over an empty list.
    const alone = { ...LIST, rows: 0, open: true }
    expect(ledgerCommand('1', alone)).toEqual({ type: 'act', index: 0 })
    expect(ledgerCommand('3', alone)).toEqual({ type: 'act', index: 2 })
    expect(ledgerCommand('j', alone)).toBeNull()
  })

  test('Esc takes back the nearest thing: a question, the record, the checks', () => {
    expect(ledgerCommand('Escape', { ...LIST, prompt: true, open: true, checked: 2 })).toEqual({
      type: 'cancelPrompt',
    })
    expect(ledgerCommand('Escape', { ...LIST, open: true, checked: 2 })).toEqual({
      type: 'close',
    })
    expect(ledgerCommand('Escape', { ...LIST, checked: 2 })).toEqual({ type: 'clearChecks' })
    // Nothing to take back: the browser keeps its Esc.
    expect(ledgerCommand('Escape', LIST)).toBeNull()
  })

  test('other keys are the browser’s', () => {
    expect(ledgerCommand('a', LIST)).toBeNull()
    expect(ledgerCommand('Tab', LIST)).toBeNull()
    expect(ledgerCommand(' ', LIST)).toBeNull()
  })
})

describe('scrolling a row into view', () => {
  test('a key that moved to a row scrolls to it once the focus is there', () => {
    expect(scrollTarget('b', 'b')).toBe('b')
    // The record follows the key a render later: nothing until the focus arrives.
    expect(scrollTarget('b', 'a')).toBeNull()
  })

  test('a focus no key moved (an area opened, a new filter, a click) scrolls nothing', () => {
    expect(scrollTarget(null, 'a')).toBeNull()
    expect(scrollTarget(null, null)).toBeNull()
  })
})

describe('stepping', () => {
  const ids = ['a', 'b', 'c']

  test('moves one row, and holds at either end', () => {
    expect(stepTo(ids, 'a', 1)).toBe('b')
    expect(stepTo(ids, 'b', -1)).toBe('a')
    expect(stepTo(ids, 'c', 1)).toBe('c')
    expect(stepTo(ids, 'a', -1)).toBe('a')
  })

  test('from nowhere, j starts at the top and k at the end', () => {
    expect(stepTo(ids, null, 1)).toBe('a')
    expect(stepTo(ids, 'gone', -1)).toBe('c')
    expect(stepTo([], null, 1)).toBeNull()
  })
})
