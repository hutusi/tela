import { applyD1Migrations, env } from 'cloudflare:test'

// Setup files run before each test file; applyD1Migrations skips what is already applied.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
