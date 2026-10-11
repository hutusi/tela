import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import {
  currentToast,
  dismissToast,
  pauseToast,
  resumeToast,
  runToastAction,
  showToast,
  TOAST_MS,
  UNDO_MS,
} from '../src/lib/toasts'

describe('toasts', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    dismissToast()
    jest.useRealTimers()
  })

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

  test('a message goes when its time is up; one with an action stays longer', () => {
    showToast('Recommended.')
    jest.advanceTimersByTime(TOAST_MS - 1)
    expect(currentToast()).not.toBeNull()
    jest.advanceTimersByTime(1)
    expect(currentToast()).toBeNull()

    showToast('Marked 3 posts read.', { label: 'Undo', run: () => {} })
    jest.advanceTimersByTime(UNDO_MS - 1)
    expect(currentToast()).not.toBeNull()
    jest.advanceTimersByTime(1)
    expect(currentToast()).toBeNull()
  })

  test('paused while it is used, it keeps the time it had left', () => {
    const id = showToast('Marked 3 posts read.', { label: 'Undo', run: () => {} })
    jest.advanceTimersByTime(3000)
    pauseToast(id)
    // However long the pointer stays over it.
    jest.advanceTimersByTime(60_000)
    expect(currentToast()?.id).toBe(id)
    // Paused twice is still paused once; resumed, it has the 2 s it had.
    pauseToast(id)
    resumeToast(id)
    resumeToast(id)
    jest.advanceTimersByTime(UNDO_MS - 3000 - 1)
    expect(currentToast()?.id).toBe(id)
    jest.advanceTimersByTime(1)
    expect(currentToast()).toBeNull()
  })

  test("pausing or resuming another toast's id changes nothing", () => {
    const old = showToast('Recommended.')
    const id = showToast('Marked 3 posts read.', { label: 'Undo', run: () => {} })
    pauseToast(old)
    jest.advanceTimersByTime(UNDO_MS)
    expect(currentToast()).toBeNull()

    const next = showToast('Marked 3 posts read.', { label: 'Undo', run: () => {} })
    pauseToast(next)
    resumeToast(id)
    jest.advanceTimersByTime(UNDO_MS * 2)
    expect(currentToast()?.id).toBe(next)
  })

  test('settle is called once when it goes without its action: expired, dismissed or replaced', () => {
    const settled: string[] = []
    const offer = (name: string) =>
      showToast(name, { label: 'Undo', run: () => {}, settle: () => settled.push(name) })

    offer('expires')
    jest.advanceTimersByTime(UNDO_MS)
    expect(settled).toEqual(['expires'])

    const dismissed = offer('dismissed')
    dismissToast(dismissed)
    dismissToast(dismissed)
    expect(settled).toEqual(['expires', 'dismissed'])

    offer('replaced')
    expect(settled).toEqual(['expires', 'dismissed'])
    showToast('Recommended.')
    expect(settled).toEqual(['expires', 'dismissed', 'replaced'])
    // Its timer is gone with it.
    jest.advanceTimersByTime(UNDO_MS * 2)
    expect(settled).toEqual(['expires', 'dismissed', 'replaced'])
  })

  test('settle is not called once its action has run', () => {
    let settled = 0
    let ran = 0
    const id = showToast('Highlight removed.', {
      label: 'Undo',
      run: () => ran++,
      settle: () => settled++,
    })
    runToastAction(id)
    jest.advanceTimersByTime(UNDO_MS * 2)
    dismissToast()
    showToast('Recommended.')
    expect([ran, settled]).toEqual([1, 0])
  })

  test('an action that says something new is not that new message replacing it', () => {
    let settled = 0
    const id = showToast('Marked 300 posts read.', {
      label: 'Undo',
      run: () => showToast('Already sent.'),
      settle: () => settled++,
    })
    runToastAction(id)
    expect(currentToast()?.text).toBe('Already sent.')
    expect(settled).toBe(0)
  })
})
