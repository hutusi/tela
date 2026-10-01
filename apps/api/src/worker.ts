/**
 * tela-api on Cloudflare (ADR 0024). Placement pins it beside the D1 primary in Singapore; it has
 * no public route and is reached only through tela-web's service binding. One app per isolate:
 * better-auth's setup is not free, and the bindings do not change under a running isolate.
 */
import type { Request as CfRequest, ExecutionContext } from '@cloudflare/workers-types'
import { schema } from '@tela/data'
import { type Mail, memoryMail, resendMail, systemClock } from '@tela/platform'
import { d1Db, queueJobs, r2Blobs } from '@tela/platform/cloudflare'
import { createApp } from './app'
import type { Env } from './env'

let cached: { env: Env; app: ReturnType<typeof createApp>['app'] } | undefined

function mailFor(env: Env): Mail {
  if (env.ENV === 'test') return memoryMail()
  if (!env.RESEND_API_KEY) {
    // No key: fail loudly at send time rather than pretend a code went out.
    return {
      async send() {
        throw new Error('RESEND_API_KEY is not set; sign-in mail cannot be sent')
      },
    }
  }
  return resendMail({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM })
}

function appFor(env: Env) {
  if (cached?.env === env) return cached.app
  const { app } = createApp({
    db: d1Db(env.DB, schema),
    blobs: r2Blobs(env.BLOBS),
    jobs: queueJobs({
      fetch: env.FETCH_QUEUE,
      extract: env.EXTRACT_QUEUE,
      translate: env.TRANSLATE_QUEUE,
      misc: env.MISC_QUEUE,
    }),
    clock: systemClock,
    mail: mailFor(env),
    ingest: env.JOBS,
    ...(env.ENV === 'test' ? { cycle: (options) => env.JOBS.cycle(options) } : {}),
    config: {
      publicUrl: env.PUBLIC_URL,
      authSecret: env.AUTH_SECRET,
      ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}),
      mailFrom: env.MAIL_FROM,
      testMode: env.ENV === 'test',
      ...(env.GRAVATAR_URL ? { gravatarUrl: env.GRAVATAR_URL } : {}),
    },
  })
  cached = { env, app }
  return app
}

export default {
  fetch(request: CfRequest, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    return appFor(env).fetch(request as unknown as Request, env, ctx as never)
  },
}
