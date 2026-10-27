import { describe, expect, test } from 'bun:test'
import { API_CURRENT_VERSION, type ApiVersion, apiVersionOf } from './apps'

describe('the version an API answer says it is', () => {
  test('is the one in its path, and the current one outside a version', () => {
    expect(apiVersionOf('/v1/sync')).toBe(1)
    expect(apiVersionOf('/v1')).toBe(1)
    expect(apiVersionOf('/meta')).toBe(API_CURRENT_VERSION)
    expect(apiVersionOf('/oauth/token')).toBe(API_CURRENT_VERSION)
    // A version Tela never had is no version: the current one answers it, with a 404.
    expect(apiVersionOf('/v9/sync')).toBe(API_CURRENT_VERSION)
    expect(apiVersionOf('/v1x/sync')).toBe(API_CURRENT_VERSION)
  })

  test('so v1 still says 1 once a v2 is current', () => {
    const versions: ApiVersion[] = [
      { version: 1, status: 'deprecated', sunsetAt: 0 },
      { version: 2, status: 'stable', sunsetAt: null },
    ]
    expect(apiVersionOf('/v1/sync', versions, 2)).toBe(1)
    expect(apiVersionOf('/v2/sync', versions, 2)).toBe(2)
    expect(apiVersionOf('/meta', versions, 2)).toBe(2)
  })
})
