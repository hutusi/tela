import { join } from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// The D1 half of the data contract: the same suite `bun test` runs on libSQL, run inside workerd
// against Miniflare's D1, which is the SQLite build production uses.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(join(import.meta.dirname, '../../migrations'))
  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: '2026-06-01',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ['test/workers/**/*.workers.ts'],
      setupFiles: ['test/workers/apply-migrations.ts'],
    },
  }
})
