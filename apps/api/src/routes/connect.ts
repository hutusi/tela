/**
 * Connecting an app (ADR 0064): the consent page's two questions, and Settings → Connected apps.
 * Internal member routes under `/api/v1`, so the web's origin, member and client checks apply, and
 * the session is the member's own: an app's token is never accepted here.
 *
 * - `GET /connect/request?<AuthorizationParams>`: the authorization request, checked, as the page
 *   shows it (`ConnectRequest`), or `{ error }` (`CONNECT_ERRORS`), which the page shows itself and
 *   never redirects on.
 * - `POST /connect/decide {ConnectDecision}`: the request checked again, and the member's answer
 *   as `{ redirect }`, where the page sends the browser: with a code on approval (RFC 6749
 *   §4.1.2), `access_denied` on decline, and the issuer either way (RFC 9207).
 * - `GET /connections`: the member's live connections.
 * - `DELETE /connections/:id`: one ended, with every device's tokens under it.
 */
import {
  approveConnection,
  type ConsentApp,
  consumeLimit,
  endConnection,
  listConnections,
  readConsentApp,
} from '@tela/data'
import {
  type AppScope,
  type AuthorizationParams,
  type ConnectError,
  type ConnectRequest,
  lowerScope,
} from '@tela/shared'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { Auth } from '../auth'
import type { ApiDeps } from '../deps'
import { answerAt, isChallenge, matchRedirect, parseScope, STATE_MAX } from '../gateway/authorize'

/** The authorization request's parameters, as the page passes them through (RFC 6749 names). */
const PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const

type Checked =
  | {
      ok: true
      app: ConsentApp
      params: AuthorizationParams
      /** What the member is offered: what was asked, within the app's ceiling and permission. */
      scope: AppScope
      email: boolean
      redirect: ConnectRequest['redirect']
    }
  | { ok: false; error: ConnectError }

const refused = (error: ConnectError): Checked => ({ ok: false, error })

/**
 * Check an authorization request for a member, in the order a page can trust: the client, then
 * the redirect (until both pass, nothing may be sent anywhere), then the rest. `fields` holds each
 * parameter once, or an array when it came more than once, which RFC 6749 §3.1 forbids.
 */
async function check(
  deps: ApiDeps,
  userId: string,
  fields: Record<string, unknown>,
): Promise<Checked> {
  const given: Partial<Record<(typeof PARAMS)[number], string>> = {}
  for (const name of PARAMS) {
    const v = fields[name]
    if (typeof v === 'string') given[name] = v
    else if (v !== undefined) return refused('invalid_request')
  }
  const value = (name: (typeof PARAMS)[number]) => given[name]
  const clientId = value('client_id')
  if (!clientId) return refused('invalid_client')
  const app = await readConsentApp(deps.db, clientId, userId)
  // A draft is offered only to its owner; anyone else is told no such client, as for none.
  if (!app || (app.status === 'draft' && app.ownerUserId !== userId)) {
    return refused('invalid_client')
  }
  if (!app.grantTypes.includes('code')) return refused('invalid_client')
  const redirectUri = value('redirect_uri')
  const redirect = redirectUri ? matchRedirect(app.redirectUris, redirectUri) : null
  if (!redirectUri || !redirect) return refused('invalid_redirect')
  if (app.status === 'suspended') return refused('app_unavailable')
  const responseType = value('response_type')
  if (responseType !== 'code') {
    return refused(responseType ? 'unsupported_response_type' : 'invalid_request')
  }
  const asked = parseScope(value('scope') ?? '')
  if (!asked) return refused('invalid_scope')
  const challenge = value('code_challenge')
  const state = value('state')
  if (
    value('code_challenge_method') !== 'S256' ||
    !challenge ||
    !isChallenge(challenge) ||
    (state !== undefined && state.length > STATE_MAX)
  ) {
    return refused('invalid_request')
  }
  if (!app.connected && app.maxConnections !== null && app.connections >= app.maxConnections) {
    return refused('max_connections')
  }
  return {
    ok: true,
    app,
    params: {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: responseType,
      scope: value('scope') ?? '',
      ...(state === undefined ? {} : { state }),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
    scope: lowerScope(asked.scope, app.maxScope),
    email: asked.email && app.allowEmail,
    redirect,
  }
}

/** A query's parameters, each once, or as an array when it came more than once. */
function queryFields(url: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [name, value] of new URL(url).searchParams) {
    const seen = fields[name]
    fields[name] = seen === undefined ? value : [seen, value].flat()
  }
  return fields
}

export function connectRoutes(deps: ApiDeps, auth: Auth) {
  const { db, clock, config } = deps
  const routes = new Hono<ApiEnv>()

  routes.get('/connect/request', async (c) => {
    const checked = await check(deps, c.get('member').id, queryFields(c.req.url))
    if (!checked.ok) return c.json({ error: checked.error }, 400, { 'cache-control': 'no-store' })
    const { app } = checked
    const answer: ConnectRequest = {
      app: {
        clientId: app.clientId,
        name: app.name,
        developer: app.developer,
        homepageUrl: app.homepageUrl,
        privacyUrl: app.privacyUrl,
        status: app.status === 'draft' ? 'draft' : 'approved',
      },
      scope: checked.scope,
      email: checked.email,
      redirect: checked.redirect,
    }
    return c.json(answer, 200, { 'cache-control': 'no-store' })
  })

  /**
   * The member's answer. The request is checked again, as anything may have changed since the page
   * asked (the app cut off, its ceiling lowered, the cap reached), and the member may grant less
   * than offered, never more. Approving always makes a new code, even for an app already
   * connected: a `client_id` is public, so a silent re-approval would hand tokens to anything that
   * names it (RFC 8252 §8.6).
   */
  routes.post('/connect/decide', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (typeof body !== 'object' || body === null) return c.json({ error: 'invalid_request' }, 400)
    const member = c.get('member')
    // The session itself, read from D1 past its signed five-minute copy, as the account routes
    // read it: approving mints tokens that outlive any session, so a session ended by a password
    // reset or sign-out everywhere must not approve anything in the minutes its copy still works.
    const live = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
    })
    if (!live || live.user.id !== member.id) return c.json({ error: 'unauthorized' }, 401)
    const checked = await check(deps, member.id, body)
    if (!checked.ok) return c.json({ error: checked.error }, 400)
    const { decision, scope_granted: granted, email_granted: emailGranted } = body
    if (decision !== 'approve' && decision !== 'decline') {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const now = clock.now()
    const limited = await consumeLimit(db, 'appConnect', member.id, now)
    if (!limited.allowed) {
      return c.json({ error: 'rate_limited' }, 429, {
        'retry-after': String(limited.retryAfterSec),
      })
    }
    const { params } = checked
    const answer = { state: params.state, iss: config.apiUrl }
    if (decision === 'decline') {
      return c.json({
        redirect: answerAt(params.redirect_uri, { error: 'access_denied', ...answer }),
      })
    }
    if ((granted !== 'read' && granted !== 'write') || typeof emailGranted !== 'boolean') {
      return c.json({ error: 'invalid_request' }, 400)
    }
    if (lowerScope(granted, checked.scope) !== granted)
      return c.json({ error: 'invalid_scope' }, 400)
    if (emailGranted && !checked.email) return c.json({ error: 'invalid_scope' }, 400)
    const approved = await approveConnection(db, {
      appId: checked.app.id,
      userId: member.id,
      scope: granted,
      email: emailGranted,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      now,
    })
    if (!approved) {
      // Something changed between the check and the write: say what, as the page would have.
      const again = await check(deps, member.id, body)
      return c.json({ error: again.ok ? 'app_unavailable' : again.error }, 409)
    }
    return c.json({ redirect: answerAt(params.redirect_uri, { code: approved.code, ...answer }) })
  })

  routes.get('/connections', async (c) => {
    const connections = await listConnections(db, c.get('member').id, clock.now())
    return c.json({ connections }, 200, { 'cache-control': 'no-store' })
  })

  routes.delete('/connections/:id{[0-9]+}', async (c) => {
    const ended = await endConnection(db, {
      userId: c.get('member').id,
      grantId: Number(c.req.param('id')),
      reason: 'disconnected',
      now: clock.now(),
    })
    return ended ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
  })

  return routes
}
