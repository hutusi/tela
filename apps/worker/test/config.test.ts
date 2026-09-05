import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../src/config'

const base = { DATABASE_URL: 'postgresql://x:y@localhost:5432/tela' }

describe('loadConfig', () => {
  test('refuses the translate role on the fallback mock, allows it on purpose or with a key', () => {
    expect(() => loadConfig({ ...base, WORKER_ROLES: 'translate' })).toThrow(/LLM_PROVIDER=mock/)
    expect(() =>
      loadConfig({ ...base, WORKER_ROLES: 'fetch,translate', LLM_PROVIDER: 'bailian' }),
    ).toThrow(/LLM_PROVIDER=mock/)
    expect(loadConfig({ ...base, WORKER_ROLES: 'translate', LLM_PROVIDER: 'mock' }).roles).toEqual([
      'translate',
    ])
    expect(loadConfig({ ...base, WORKER_ROLES: 'translate', BAILIAN_API_KEY: 'k' }).roles).toEqual([
      'translate',
    ])
    expect(() =>
      loadConfig({ ...base, WORKER_ROLES: 'translate', LLM_PROVIDER: 'bailain' }),
    ).toThrow(/Unknown LLM_PROVIDER/)
  })

  test('roles without translate do not need an LLM key', () => {
    expect(loadConfig({ ...base, WORKER_ROLES: 'scheduler,fetch' }).roles).toEqual([
      'scheduler',
      'fetch',
    ])
  })

  test('keeps the existing role and env checks', () => {
    expect(() => loadConfig({ WORKER_ROLES: 'fetch' })).toThrow(/DATABASE_URL/)
    expect(() => loadConfig({ WORKER_ROLES: 'relay' })).toThrow(/RELAY_SECRET/)
    expect(loadConfig({ WORKER_ROLES: 'relay', RELAY_SECRET: 'x'.repeat(32) }).needsDb).toBe(false)
  })
})
