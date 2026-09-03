import { z } from 'zod'
import { parseRoles } from './roles'

const envSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  WORKER_ROLES: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HEARTBEAT_SEC: z.coerce.number().int().positive().default(60),
})

export type WorkerConfig = ReturnType<typeof loadConfig>

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Invalid worker environment: ${parsed.error.message}`)
  }
  const roles = parseRoles(parsed.data.WORKER_ROLES)
  const needsDb = roles.some((r) => r !== 'relay')
  if (needsDb && !parsed.data.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for roles other than relay')
  }
  return { ...parsed.data, roles, needsDb }
}
