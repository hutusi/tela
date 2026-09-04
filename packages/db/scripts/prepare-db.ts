/**
 * Prepare an existing Postgres for local runs or CI: Supabase stand-in (auth schema, roles),
 * all migrations, grants, and the development user. Idempotent.
 *   DATABASE_URL=postgresql://... bun run scripts/prepare-db.ts
 */
import { sql } from 'drizzle-orm'
import { createDb } from '../src/client'
import { prepareDatabase } from '../src/testing/local-postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const db = createDb(url, { max: 2 })
try {
  await prepareDatabase(db)
  await db.execute(
    sql`insert into auth.users (id, email, raw_user_meta_data)
        values ('00000000-0000-4000-8000-000000000001', 'dev@tela.local', '{"full_name":"Dev User"}'::jsonb)
        on conflict (id) do nothing`,
  )
  console.log('database prepared')
} finally {
  await db.close()
}
