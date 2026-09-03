import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from '../src/client'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const db = createDb(url, { max: 1 })
try {
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname })
  console.log('migrations applied')
} finally {
  await db.close()
}
