/**
 * The security headers (ADR 0051): one set, given to the shell by `public/_headers` and to the
 * edge's pages by `withSecurityHeaders`, and a policy that names the inline script by the hash of
 * what `index.html` holds today, recomputed here so the two cannot drift.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  THEME_SCRIPT_HASH,
  withSecurityHeaders,
} from '../worker/security'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const INDEX = read('../index.html')
const HEADERS = read('../public/_headers')

/** The rules of a `_headers` file: each path pattern and its headers, names lowercased. */
function rules(text: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  let current: Record<string, string> | null = null
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      current = {}
      out.set(line.trim(), current)
      continue
    }
    const at = line.indexOf(':')
    if (current && at > 0) {
      current[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
    }
  }
  return out
}

describe('the content security policy', () => {
  test('names every inline script index.html runs by its hash, and nothing else inline', () => {
    const inline = [...INDEX.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
      // A data block is never run, and needs no hash.
      .filter((m) => !/type=["']application\/(ld\+)?json["']/.test(m[1] ?? ''))
      .map(
        (m) =>
          `sha256-${createHash('sha256')
            .update(m[2] ?? '')
            .digest('base64')}`,
      )
    expect(inline).toEqual([THEME_SCRIPT_HASH])
    expect(CONTENT_SECURITY_POLICY).toContain(`script-src 'self' '${THEME_SCRIPT_HASH}'`)
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*unsafe-inline/)
  })

  test('is report-only, while the rest is enforced', () => {
    expect(SECURITY_HEADERS['content-security-policy-report-only']).toBe(CONTENT_SECURITY_POLICY)
    expect(SECURITY_HEADERS).not.toHaveProperty('content-security-policy')
    expect(SECURITY_HEADERS['x-frame-options']).toBe('DENY')
    expect(SECURITY_HEADERS['strict-transport-security']).toBe('max-age=31536000')
  })
})

describe('_headers', () => {
  test('gives every page the asset router serves the same set the edge sets', () => {
    expect(rules(HEADERS).get('/*')).toEqual({ ...SECURITY_HEADERS })
  })

  test('keeps hashed assets a day, never a year or immutable (AGENTS.md)', () => {
    expect(rules(HEADERS).get('/assets/*')).toEqual({ 'cache-control': 'public, max-age=86400' })
  })
})

describe('withSecurityHeaders', () => {
  test('sets them on a copy, the body untouched', async () => {
    const fetched = new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
    const page = withSecurityHeaders(fetched)
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(page.headers.get(name)).toBe(value)
    }
    expect(await page.text()).toBe('<!doctype html>')
  })
})
