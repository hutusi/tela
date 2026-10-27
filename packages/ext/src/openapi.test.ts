import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { OPENAPI_PATH } from '../scripts/openapi'
import { openapiDocument, openapiText } from './openapi'

describe('the OpenAPI document', () => {
  // Generated from the schemas (`bun run api:openapi`), so a format changed without regenerating,
  // or the document edited by hand, fails here rather than drifting from what the API answers.
  test('is what `bun run api:openapi` writes from the v1 formats', () => {
    const committed = readFileSync(OPENAPI_PATH, 'utf8')
    if (committed !== openapiText()) {
      throw new Error(
        'docs/api/openapi.json does not match the v1 schemas: run `bun run api:openapi` and commit what it writes',
      )
    }
    expect(committed).toBe(openapiText())
  })

  test('is OpenAPI 3.1, with a scope on every route that takes a token', () => {
    const doc = openapiDocument() as {
      openapi: string
      paths: Record<string, Record<string, { security: { tela?: string[] }[]; responses: object }>>
    }
    expect(doc.openapi).toBe('3.1.0')
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const open = path === '/meta' || path === '/v1/openapi.json'
        expect(op.security, `${method} ${path}`).toEqual(open ? [] : [expect.anything()])
        if (!open) {
          // Every route that takes a token can be refused it, limited, or paused.
          expect(Object.keys(op.responses), `${method} ${path}`).toEqual(
            expect.arrayContaining(['200', '401', '429', '503']),
          )
          const scope = op.security[0]?.tela?.[0]
          if (method === 'post') expect(scope, `${method} ${path}`).toBe('write')
          if (scope === 'write') expect(Object.keys(op.responses)).toContain('403')
        }
      }
    }
  })

  test('lists every refusal a route can give: the token’s, the limits’, and bad input', () => {
    type Op = {
      security: { tela?: string[] }[]
      parameters?: { in: string }[]
      requestBody?: object
      responses: Record<string, { description?: string; headers?: object }>
    }
    const doc = openapiDocument() as { paths: Record<string, Record<string, Op>> }
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const name = `${method} ${path}`
        if (op.security.length > 0) {
          // Any token can be refused, its app cut off (403 `app_suspended`), limited or paused.
          expect(Object.keys(op.responses), name).toEqual(
            expect.arrayContaining(['401', '403', '429', '503']),
          )
          const forbidden = op.responses['403']
          expect(forbidden?.description, name).toContain('app_suspended')
          expect(forbidden?.description?.includes('insufficient_scope'), name).toBe(
            op.security[0]?.tela?.[0] === 'write',
          )
          expect(Object.keys(forbidden?.headers ?? {}), name).toContain('WWW-Authenticate')
        }
        // A route that reads a query or a body refuses one it cannot take.
        if (op.requestBody || op.parameters?.some((p) => p.in === 'query')) {
          expect(Object.keys(op.responses), name).toContain('400')
        }
      }
    }
  })

  test('says every 429 and 503 carries Retry-After', () => {
    const doc = openapiDocument() as {
      paths: Record<string, Record<string, { responses: Record<string, { headers?: object }> }>>
    }
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        for (const status of ['429', '503']) {
          const res = op.responses[status]
          if (res) expect(Object.keys(res.headers ?? {})).toContain('Retry-After')
        }
      }
    }
  })
})
