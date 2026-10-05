/**
 * The admin console's toast as a sequence (ADR 0039): each message is numbered, and an undo's
 * answer replaces only the toast it undid.
 */
import { describe, expect, test } from 'bun:test'
import { NO_TOAST, type ToastEvent, type ToastState, toastReducer } from '../src/admin/toasts'

const run = (events: ToastEvent[], from: ToastState = NO_TOAST) => events.reduce(toastReducer, from)

describe('the toast', () => {
  test('each message is numbered anew, even with the same words', () => {
    const one = run([{ type: 'say', text: 'Hidden · Nordvest', undo: 'g1' }])
    expect(one.toast).toEqual({ id: 1, text: 'Hidden · Nordvest', undo: 'g1', error: false })
    const two = run([{ type: 'say', text: 'Hidden · Nordvest', undo: 'g1' }], one)
    expect(two.toast?.id).toBe(2)
  })

  test('an undo that is out leaves nothing on its toast to take back', () => {
    const shown = run([{ type: 'say', text: 'Hidden · Nordvest', undo: 'g1' }])
    const undoing = run([{ type: 'undoing', id: 1 }], shown)
    expect(undoing.toast).toEqual({ id: 1, text: 'Hidden · Nordvest', undo: null, error: false })
    // Only that toast's: a stale U for an older one changes nothing.
    expect(run([{ type: 'undoing', id: 7 }], shown)).toBe(shown)
  })

  test('an undo’s answer replaces the toast it undid', () => {
    const state = run([
      { type: 'say', text: 'Hidden · Nordvest', undo: 'g1' },
      { type: 'undoing', id: 1 },
      { type: 'reply', to: 1, text: 'Undone', error: false },
    ])
    expect(state.toast).toEqual({ id: 2, text: 'Undone', undo: null, error: false })
  })

  test('a late answer never takes a newer toast’s words or its Undo', () => {
    const state = run([
      { type: 'say', text: 'Hidden · Nordvest', undo: 'g1' },
      { type: 'undoing', id: 1 },
      // A newer action is answered before the undo is.
      { type: 'say', text: 'Paused · nordvest.example/feed.xml', undo: 'g2' },
      { type: 'reply', to: 1, text: 'Undone', error: false },
    ])
    expect(state.toast).toEqual({
      id: 2,
      text: 'Paused · nordvest.example/feed.xml',
      undo: 'g2',
      error: false,
    })
  })

  test('an answer after its toast timed out still says how the undo went', () => {
    const state = run([
      { type: 'say', text: 'Hidden · Nordvest', undo: 'g1' },
      { type: 'undoing', id: 1 },
      { type: 'dismiss', id: 1 },
      { type: 'reply', to: 1, text: 'Something changed since', error: true },
    ])
    expect(state.toast).toEqual({
      id: 2,
      text: 'Something changed since',
      undo: null,
      error: true,
    })
  })

  test('a toast’s timer takes down that toast only', () => {
    const state = run([
      { type: 'say', text: 'Hidden · Nordvest', undo: 'g1' },
      { type: 'say', text: 'Featured · Pfadwerk', undo: 'g2' },
      { type: 'dismiss', id: 1 },
    ])
    expect(state.toast?.text).toBe('Featured · Pfadwerk')
    expect(run([{ type: 'dismiss', id: 2 }], state).toast).toBeNull()
    expect(run([{ type: 'dismiss' }], state).toast).toBeNull()
  })
})
