/**
 * Boot: open the device's store, render from it straight away, then sync behind it. Nothing here
 * waits on the network before the first paint (ADR 0025).
 */
import './styles.css'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { leaver } from './leave'
import { openStore, sessionEvents } from './session'
import { registerShell } from './shell'
import { bindApi } from './store/api'
import { indexedDbPersistence, memoryPersistence } from './store/db'
import { SyncEngine } from './store/engine'
import { Objects } from './store/objects'

async function boot() {
  // A browser that refuses IndexedDB (some private modes) still reads, just without a memory.
  const persistence = await indexedDbPersistence().catch(() => memoryPersistence())
  const store = await openStore(persistence)
  const objects = new Objects(persistence)

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

  const root = document.getElementById('root')
  if (!root) throw new Error('no #root')
  createRoot(root).render(<App store={store} engine={engine} objects={objects} />)
  registerShell.register()
  // Old bodies go once the page has settled; nothing waits on it.
  setTimeout(() => void objects.evict(), 10_000)
}

void boot()
