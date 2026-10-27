/**
 * Boot: open the device's store, render from it straight away, then sync behind it. Nothing here
 * waits on the network before the first paint (ADR 0025).
 *
 * Nothing here may leave the page blank either. A device store that opens and then fails (a full
 * disk, a copy IndexedDB will not read) is replaced by one in memory: the app runs, and only
 * forgets between visits. A render that throws is caught by the root boundary, which needs no
 * provider, and a boot that fails all the same says so in the page's language, unless the edge
 * already rendered the page, which then stays as it reads without JavaScript. Each failure is
 * reported (`lib/report.ts`).
 */
import './styles.css'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { AppFailed, bareLocale, ErrorBoundary } from './components/error-boundary'
import { leaver } from './leave'
import { report, watchErrors } from './lib/report'
import { pageTheme, paintChrome } from './lib/typography'
import { openStore, sessionEvents } from './session'
import { registerShell } from './shell'
import { bindApi } from './store/api'
import {
  type EarlierBuild,
  earlierBuild,
  indexedDbPersistence,
  memoryPersistence,
  type Persistence,
} from './store/db'
import { SyncEngine } from './store/engine'
import { Objects, REQUEST_TIMEOUT_MS } from './store/objects'

/** An earlier build's database is IndexedDB's to look at, and a memory store has none. */
const NO_EARLIER: EarlierBuild = {
  wrote: async () => false,
  empty: async () => null,
  seen: async () => undefined,
}

/** The store on the device, or, when the device refuses it, one in memory. */
async function deviceStore() {
  // A browser that refuses IndexedDB (some private modes) still reads, just without a memory.
  const persistence: Persistence = await indexedDbPersistence().catch(() => memoryPersistence())
  try {
    // A start-over is a full download, and its cause is gone with the copy: told while it is known.
    const restarted = (why: string) => report('restart', why)
    return { persistence, store: await openStore(persistence, earlierBuild, restarted) }
  } catch (err) {
    report('boot', err)
    const memory = memoryPersistence()
    return { persistence: memory, store: await openStore(memory, NO_EARLIER) }
  }
}

async function boot(root: HTMLElement) {
  // A page the edge rendered is in the language it chose, which the app's first render keeps
  // (`bootLocale`). Read before anything replaces the page.
  const rendered = root.childElementCount > 0 ? document.documentElement.lang : null
  // The browser's bar follows a theme this device chose, which the inline script has put on the
  // page; a member's synced one applies again once their rows are in.
  paintChrome(pageTheme())
  const { persistence, store } = await deviceStore()
  // A refusal for the day's limit (ADR 0066) is the account's that asked, not the next one's.
  const objects = new Objects(persistence, Date.now, REQUEST_TIMEOUT_MS, () => store.userId)

  const leave = leaver({
    stop: () => engine.stop(),
    store,
    go: (path) => window.location.assign(path),
  })
  // This app is older than the protocol: fetch the new shell rather than misread rows.
  const upgrade = () => void registerShell.upgrade()

  const engine = new SyncEngine(store, {
    onSignedOut: () => sessionEvents.signedOut(),
    onUpgrade: upgrade,
    // Also what the store's refused writes come to (the engine hears them first).
    onAccountChanged: leave,
  })
  // Every call names the account the tab holds, and any call can find out it is out of date.
  bindApi({ member: () => store.userId, accountChanged: leave, upgrade })

  // A page's boundary showed Try again, or the root's showed the app's failure: told to tela-api,
  // and to the console as React would have.
  const caught = (error: unknown) => {
    console.error(error)
    report('boundary', error)
  }
  createRoot(root, { onCaughtError: caught, onUncaughtError: caught }).render(
    <ErrorBoundary fallback={() => <AppFailed locale={bareLocale()} />}>
      <App store={store} engine={engine} objects={objects} rendered={rendered} />
    </ErrorBoundary>,
  )
  registerShell.register()
  // Old bodies go once the page has settled; nothing waits on it.
  setTimeout(() => void objects.evict(), 10_000)
}

watchErrors()
const root = document.getElementById('root')
if (root) {
  boot(root).catch((err: unknown) => {
    report('boot', err)
    // A page the edge rendered reads as it is; an empty shell says what went wrong.
    if (root.childElementCount > 0) return
    createRoot(root).render(<AppFailed locale={bareLocale()} />)
  })
}
