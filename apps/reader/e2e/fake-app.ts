/**
 * An app as `docs/api/authorization.md` has a desktop app connect (ADRs 0064, 0065): a listener on
 * a free loopback port, the member's browser sent to `/connect` with a PKCE challenge and a state,
 * the answer caught at the listener, and the code exchanged at tela-gateway (api.telaread.com's
 * stand-in). The specs that act as an app share it: `connect.e2e.ts` for the operator's apps,
 * `developer.e2e.ts` for those members register (ADR 0067).
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type APIRequestContext, expect } from '@playwright/test'
import { BASE, GATEWAY } from './helpers'

export type Tokens = {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  scope: string
}

/** What reaches the app's listener: the query of the address the browser was sent to. */
export type Answer = {
  code: string | null
  state: string | null
  iss: string | null
  error: string | null
}

/**
 * An app waiting for one answer: a fresh verifier, challenge and state, a listener on a free port
 * of 127.0.0.1, and the authorization request that names them. `scope` is sent as written, so
 * `write email` asks for the address too.
 */
export async function fakeApp(clientId: string, scope = 'write') {
  let answered: (answer: Answer) => void = () => undefined
  const answer = new Promise<Answer>((resolve) => {
    answered = resolve
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404)
      res.end()
      return
    }
    const q = url.searchParams
    answered({
      code: q.get('code'),
      state: q.get('state'),
      iss: q.get('iss'),
      error: q.get('error'),
    })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>The app</title><p id="fake-app">You can go back now.</p>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const redirect = `http://127.0.0.1:${port}/callback`
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return {
    url: `${BASE}/connect?${query}`,
    query,
    state,
    /** The browser's arrival at the listener, within the spec's patience. */
    answer: () =>
      Promise.race([
        answer,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('the app heard nothing')), 15_000),
        ),
      ]),
    /** The code exchanged at the token endpoint, form-encoded. */
    async exchange(http: APIRequestContext, code: string): Promise<Tokens> {
      const res = await http.post(`${GATEWAY}/oauth/token`, {
        form: {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirect,
          client_id: clientId,
          code_verifier: verifier,
        },
      })
      expect(res.status(), await res.text()).toBe(200)
      expect(res.headers()['cache-control']).toBe('no-store')
      return (await res.json()) as Tokens
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export type FakeApp = Awaited<ReturnType<typeof fakeApp>>

/** A refresh, as an app swaps its refresh token: the status and the answer's `error`, if any. */
export async function refresh(http: APIRequestContext, clientId: string, token: string) {
  const res = await http.post(`${GATEWAY}/oauth/token`, {
    form: { grant_type: 'refresh_token', refresh_token: token, client_id: clientId },
  })
  return { status: res.status(), error: ((await res.json()) as { error?: string }).error }
}

export const bearer = (tokens: Tokens) => ({ authorization: `Bearer ${tokens.access_token}` })
