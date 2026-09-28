import { join } from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// tela-api's key paths on D1 inside workerd: better-auth through the Drizzle adapter, a push's
// guarded batch, a pull. The bun suite runs everything on libSQL; this is where D1 disagrees.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    join(import.meta.dirname, '../../../../packages/data/migrations'),
  )
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
