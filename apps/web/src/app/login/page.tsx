import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getSessionUser, supabaseConfig } from '@/lib/auth'
import { isDevAuthEnabled } from '@/lib/platform/env'
import { safeNext } from '@/lib/redirect'
import { continueAsDevUser, signInWithProvider } from './actions'
import { LoginForm } from './login-form'

export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const { next, error } = await searchParams
  const user = await getSessionUser()
  if (user) redirect(safeNext(next, '/reading'))
  const t = await getTranslations('login')
  const configured = supabaseConfig() !== null
  const devAuth = await isDevAuthEnabled()

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-8 px-6 py-20 animate-fade">
      <div>
        <h1 className="font-serif text-[34px] font-medium leading-tight tracking-tight">
          {t('title')}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{t('intro')}</p>
      </div>

      {error ? (
        <p className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-2">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      {devAuth ? (
        <form action={continueAsDevUser}>
          <input type="hidden" name="next" value={next ?? ''} />
          <button
            type="submit"
            className="w-full rounded-full bg-ink px-4 py-2.5 font-medium text-paper hover:brightness-125"
            data-testid="dev-login"
          >
            {t('devUser')}
          </button>
        </form>
      ) : null}

      {configured ? (
        <>
          <LoginForm next={next ?? ''} />
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-line" />
            {t('or')}
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="flex flex-col gap-2">
            {(['github', 'google'] as const).map((provider) => (
              <form key={provider} action={signInWithProvider}>
                <input type="hidden" name="provider" value={provider} />
                <input type="hidden" name="next" value={next ?? ''} />
                <button
                  type="submit"
                  className="w-full rounded-full border border-line bg-white px-4 py-2.5 font-medium hover:border-muted"
                >
                  {t(`with.${provider}`)}
                </button>
              </form>
            ))}
          </div>
        </>
      ) : devAuth ? null : (
        <p className="text-sm text-muted">{t('errors.not_configured')}</p>
      )}
    </main>
  )
}
