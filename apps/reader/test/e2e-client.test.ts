/**
 * The e2e specs call tela-api as the app does, naming the protocol they speak. A `MIN_CLIENT` bump
 * left them on the old one, and every spec failed in setup with 409 `upgrade`; this holds the two
 * together, as `hant.test.ts` does the catalogues.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { MIN_CLIENT } from '@tela/sync'

describe('the e2e helpers', () => {
  test('speak the protocol tela-api requires', () => {
    const helpers = readFileSync(new URL('../e2e/helpers.ts', import.meta.url), 'utf8')
    expect(helpers).toContain(`export const CLIENT = '${MIN_CLIENT}'`)
    for (const spec of ['admin.e2e.ts', 'helpers.ts']) {
      const text = readFileSync(new URL(`../e2e/${spec}`, import.meta.url), 'utf8')
      expect(text).not.toMatch(/'x-tela-client': '\d+'/)
    }
  })
})
