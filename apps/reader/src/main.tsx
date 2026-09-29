/**
 * Boot: open the device's store, render from it straight away, then sync behind it. Nothing here
 * waits on the network before the first paint (ADR 0025).
 */
import './styles.css'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import { sessionEvents } from './session'
import { registerShell } from './shell'
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
  const engine = new SyncEngine(store, {
    onSignedOut: () => sessionEvents.signedOut(),
    // This app is older than the protocol: fetch the new shell rather than misread rows.
    onUpgrade: () => void registerShell.upgrade(),
    // Another tab signed in as someone else: start again as whoever the session is now.
    onAccountChanged: () => void store.forgetAccount().then(() => window.location.reload()),
  })
  const root = document.getElementById('root')
  if (!root) throw new Error('no #root')
  createRoot(root).render(<App store={store} engine={engine} objects={objects} />)
  registerShell.register()
  // Old bodies go once the page has settled; nothing waits on it.
  setTimeout(() => void objects.evict(), 10_000)
}

void boot()
