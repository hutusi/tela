/**
 * `bun run admin code`, run as the operator runs it, against a stand-in for tela-api that records
 * what it was asked. A misread argument would make a live code nobody meant (`--uses 20 WELCOME`
 * once made the code `USES` for one person), so every form it does not understand is refused
 * before anything is sent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/admin.ts', import.meta.url))

let server: Server
let base = ''
const asked: unknown[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const sent = JSON.parse(body) as { code: string; uses: number }
      asked.push(sent)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: sent.code, maxUses: sent.uses }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(() => {
  server.close()
})

/** The script's exit code, and what it asked tela-api to make. */
async function admin(...args: string[]): Promise<{ exit: number; asked: unknown[] }> {
  asked.length = 0
  const exit = await new Promise<number>((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, ADMIN_TOKEN: 'token', TELA_URL: base } },
      (error) => resolve(error ? Number(error.code) : 0),
    )
  })
  return { exit, asked: [...asked] }
}

describe('bun run admin code', () => {
  test('takes --uses N or --uses=N, before the text or after it', async () => {
    const twenty = { exit: 0, asked: [{ code: 'WELCOME', uses: 20 }] }
    expect(await admin('code', 'WELCOME', '--uses', '20')).toEqual(twenty)
    expect(await admin('code', '--uses', '20', 'WELCOME')).toEqual(twenty)
    expect(await admin('code', 'WELCOME', '--uses=20')).toEqual(twenty)
    expect(await admin('code', 'WELCOME')).toEqual({
      exit: 0,
      asked: [{ code: 'WELCOME', uses: 1 }],
    })
  })

  test('refuses anything else, and makes nothing', async () => {
    const refused = { exit: 2, asked: [] }
    // A second word, a missing text or count, a count that is not one, an unknown flag.
    expect(await admin('code', 'WELCOME', '2026', '--uses', '5')).toEqual(refused)
    expect(await admin('code', '--uses', '20')).toEqual(refused)
    expect(await admin('code', 'WELCOME', '--uses')).toEqual(refused)
    expect(await admin('code', 'WELCOME', '--uses', 'many')).toEqual(refused)
    expect(await admin('code', 'WELCOME', '--uses', '0')).toEqual(refused)
    expect(await admin('code', 'WELCOME', '-u', '20')).toEqual(refused)
    expect(await admin('code', '--', '-WELCOME')).toEqual(refused)
  })
})
