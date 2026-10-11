import { afterEach, describe, expect, test } from 'bun:test'
import { currentToast, dismissToast, runToastAction, showToast } from '../src/lib/toasts'

describe('toasts', () => {
  afterEach(() => dismissToast())

  test('a newer message replaces the one showing, and a stale id takes nothing down', () => {
    let ran = 0
    const first = showToast('Marked 3 posts read.', { label: 'Undo', run: () => ran++ })
    const second = showToast('Recommended.')
    expect(currentToast()?.id).toBe(second)
    // The first's id no longer names the toast showing: its action cannot run, nor can its
    // timer end the newer one.
    runToastAction(first)
    dismissToast(first)
    expect(ran).toBe(0)
    expect(currentToast()?.text).toBe('Recommended.')
    dismissToast(second)
    expect(currentToast()).toBeNull()
  })

  test('an action runs once, and takes its toast down', () => {
    let ran = 0
    const id = showToast('Highlight removed.', { label: 'Undo', run: () => ran++ })
    runToastAction(id)
    runToastAction(id)
    expect(ran).toBe(1)
    expect(currentToast()).toBeNull()
  })
})
