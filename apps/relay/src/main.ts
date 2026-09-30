/**
 * The relay (ADR 0008): one signed `POST /fetch` endpoint on a Hong Kong or mainland box, for
 * feeds unreachable from Cloudflare. No database, no queue, one shared secret. It is the only
 * Node process Tela still runs.
 */
import { relayConfig } from './config'
import { createSafeFetch } from './safe-fetch'
import { startRelayServer } from './server'

const config = relayConfig(process.env)
const relay = await startRelayServer({
  ...config,
  // Every hostname is resolved and pinned here, and private ranges are refused.
  fetch: createSafeFetch(),
})
console.log(JSON.stringify({ level: 'info', msg: 'relay listening', port: relay.port }))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    relay.stop().then(() => process.exit(0))
  })
}
