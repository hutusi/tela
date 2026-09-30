/** Registering the app-shell service worker (src/shell.ts). */
import { afterEach, expect, test } from 'bun:test'
import { registerShell } from '../src/shell'

const saved = {
  window: globalThis.window,
  document: globalThis.document,
  navigator: globalThis.navigator,
}
afterEach(() => {
  Object.assign(globalThis, saved)
})

/** A page in `readyState`, whose service worker registrations are recorded. */
function page(readyState: DocumentReadyState) {
  const registered: string[] = []
  const win = new EventTarget()
  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { register: async (url: string) => void registered.push(url) } },
    configurable: true,
  })
  Object.assign(globalThis, { window: win, document: { readyState } })
  return { registered, win }
}

test('a page that has already loaded registers the worker at once', () => {
  // Found in a real browser: the boot awaits IndexedDB before registering, the page had loaded
  // by then, and a listener for `load` never ran.
  const { registered } = page('complete')
  registerShell.register()
  expect(registered).toEqual(['/sw.js'])
})

test('a page still loading registers it once loaded, and once', () => {
  const { registered, win } = page('interactive')
  registerShell.register()
  expect(registered).toEqual([])
  win.dispatchEvent(new Event('load'))
  win.dispatchEvent(new Event('load'))
  expect(registered).toEqual(['/sw.js'])
})
