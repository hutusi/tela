import { defineConfig } from 'drizzle-kit'

// Until the first deploy, 0000_init is regenerated in place (rm -rf migrations; generate) rather
// than stacked with alters: no database holds it yet. After that, only new migrations.
//
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
