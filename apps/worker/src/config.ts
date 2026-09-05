import { configFromEnv, isAccidentalMock } from '@tela/llm'
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
  /** Ceiling on source tokens translated per article body; the rest stays as source (`partial`). */
  LLM_MAX_ARTICLE_TOKENS: z.coerce.number().int().positive().default(40_000),
  /** Public origin of the web app, used to verify rel="me" claim links. */
  PUBLIC_URL: z.string().url().default('https://tela.app'),
  /** Global workers: origin of the relay role (e.g. https://relay-hk.example.com); unset = no relay. */
  RELAY_URL: z.string().url().optional(),
  /** Shared secret that signs relay requests; required by the relay role and by RELAY_URL users. */
  RELAY_SECRET: z.string().min(16).optional(),
  /** Still accepted by the relay while a new RELAY_SECRET rolls out. */
  RELAY_SECRET_PREVIOUS: z.string().min(16).optional(),
  RELAY_PORT: z.coerce.number().int().positive().default(8787),
  /** Subscribe to feeds' WebSub hubs; needs PUBLIC_URL reachable by hubs, so off by default. */
  WEBSUB_ENABLED: z
    .enum(['0', '1'])
    .default('0')
    .transform((v) => v === '1'),
  /** Fetched before blaming an origin for timeouts: if this fails too, the worker is the problem. */
  RELAY_CONTROL_URL: z.string().url().default('https://www.cloudflare.com/cdn-cgi/trace'),
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
  if (roles.includes('relay') && !parsed.data.RELAY_SECRET) {
    throw new Error('RELAY_SECRET is required for the relay role')
  }
  if (parsed.data.RELAY_URL && !parsed.data.RELAY_SECRET) {
    throw new Error('RELAY_SECRET is required when RELAY_URL is set')
  }
  if (roles.includes('translate')) {
    // The mock's placeholder output would be cached first-write-wins for every reader, so a
    // deploy that merely forgot the key must fail here instead of poisoning the cache.
    const llm = configFromEnv(env)
    if (isAccidentalMock(llm, env)) {
      throw new Error(
        'the translate role needs BAILIAN_API_KEY or ANTHROPIC_API_KEY; set LLM_PROVIDER=mock to run the deterministic mock on purpose',
      )
    }
  }
  return { ...parsed.data, roles, needsDb }
}
