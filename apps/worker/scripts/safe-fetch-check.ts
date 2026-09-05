/**
 * Node-only check of the DNS-pinned fetch (bun test cannot exercise undici's Agent):
 *   cd apps/worker && bun build scripts/safe-fetch-check.ts --target=node --outfile dist/safe-fetch-check.js && node dist/safe-fetch-check.js
 * Needs the network: localtest.me resolves to 127.0.0.1, example.com is public. On a machine
 * whose proxy answers DNS with fake addresses (198.18.0.0/15) the public check fails too; that
 * is the vetting doing its job, run the check somewhere with real DNS.
 */
import { createSafeFetch } from '../src/net/safe-fetch'

const safeFetch = createSafeFetch()
let failed = false

async function expectBlocked(url: string) {
  try {
    await safeFetch(url)
    console.error(`FAIL ${url}: fetched instead of being blocked`)
    failed = true
  } catch (err) {
    const cause = (err as { cause?: { code?: string; name?: string; message?: string } }).cause
    if (cause?.code === 'EBLOCKED') console.log(`ok   ${url}: blocked`)
    else {
      console.error(
        `FAIL ${url}: failed with ${cause?.code ?? cause?.name ?? String(err)} (${cause?.message ?? ''}), not EBLOCKED`,
      )
      failed = true
    }
  }
}

async function expectOk(url: string) {
  try {
    const res = await safeFetch(url)
    console.log(`ok   ${url}: HTTP ${res.status}`)
    await res.body?.cancel()
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause
    console.error(`FAIL ${url}: ${String(err)} (${cause?.code ?? ''} ${cause?.message ?? ''})`)
    failed = true
  }
}

await expectBlocked('http://localtest.me:9999/')
await expectBlocked('http://[fdaa::1]:9999/')
await expectBlocked('http://169.254.169.254/latest/meta-data/')
await expectOk('https://example.com/')
process.exit(failed ? 1 : 0)
