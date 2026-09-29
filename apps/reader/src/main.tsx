/**
 * Boot: open the device's store, render from it straight away, then sync behind it. Nothing here
 * waits on the network before the first paint (ADR 0025).
 */
import './styles.css'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { sessionEvents } from './session'
import { registerShell } from './shell'
import { bindApi } from './store/api'
import { indexedDbPersistence, memoryPersistence } from './store/db'
import { SyncEngine } from './store/engine'
import { LocalStore } from './store/local'
import { Objects } from './store/objects'

async function boot() {
  // A browser that refuses IndexedDB (some private modes) still reads, just without a memory.
  const persistence = await indexedDbPersistence().catch(() => memoryPersistence())
  const store = new LocalStore(persistence)
  await store.open()
  const objects = new Objects(persistence)

  /**
   * This tab holds another account than the browser's session (another tab signed in as someone
   * else), or its stored copy has been taken: forget what it holds and start again as whoever is
   * signed in now. At '/', not a reload, so nothing of the old account's (an open article, a
   * search) carries over; and whether or not the forgetting worked.
   */
  let leaving = false
  const leave = () => {
    if (leaving) return
    leaving = true
    engine.stop()
    void store
      .forgetAccount()
      .catch(() => undefined)
      .then(() => window.location.assign('/'))
  }
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
