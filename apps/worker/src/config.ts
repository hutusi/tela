import { z } from 'zod'
import { parseRoles } from './roles'

const envSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  WORKER_ROLES: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HEARTBEAT_SEC: z.coerce.number().int().positive().default(60),
  WORKER_USER_AGENT: z.string().default('Tela/0.1 (+https://tela.app/bot; feed reader)'),
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** How many feeds one fetch worker processes concurrently. */
  FETCH_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** Scheduler: maximum feeds enqueued per tick. */
  SCHEDULER_BATCH: z.coerce.number().int().positive().default(500),
  /** Daily LLM token budget for background translation; 0 = unlimited. On-demand work ignores it. */
  LLM_DAILY_BUDGET_TOKENS: z.coerce.number().int().nonnegative().default(0),
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
