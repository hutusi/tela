import { describe, expect, it } from 'bun:test'
import { dataContract, type TestApi } from './contract'
import { createTestDb } from './testing'

// The portable half of the contract: libSQL held to D1's rules. `test:workers` runs the same
// suite on D1 itself.
dataContract({ describe, it, expect } as unknown as TestApi, async () => (await createTestDb()).db)
