import { defineConfig } from 'drizzle-kit'

// Migrations are generated here and applied with `wrangler d1 migrations apply` in production and
// by the test harness on libSQL, so both run the same SQL files.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/index.ts',
  out: './migrations',
  casing: 'snake_case',
  strict: true,
  verbose: true,
})
