import { describe, expect, test } from 'bun:test'
import { sslModeFor } from '../src/client'

describe('sslModeFor', () => {
  test('requires TLS for hosted Postgres and skips it for local clusters and Hyperdrive', () => {
    expect(sslModeFor('postgresql://postgres:pw@db.abc.supabase.co:5432/postgres')).toBe('require')
    expect(
      sslModeFor(
        'postgresql://postgres.abc:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres',
      ),
    ).toBe('require')
    expect(sslModeFor('postgresql://postgres@127.0.0.1:54322/postgres')).toBe(false)
    expect(sslModeFor('postgresql://postgres@localhost/postgres')).toBe(false)
    expect(
      sslModeFor(
        'postgresql://user:pw@7a4fb1ce1f62406db8e7bef95e10f3bd.hyperdrive.local:5432/postgres',
      ),
    ).toBe(false)
    expect(sslModeFor('not a url')).toBe('require')
  })
})
