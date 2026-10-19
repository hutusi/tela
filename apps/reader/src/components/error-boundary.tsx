/**
 * What a render that throws leaves on screen: one view's failure with Try again, never a blank
 * app. The root boundary (`main.tsx`) is outside every provider, so its fallback takes its words
 * straight from the catalogues; a page's boundary (`app.tsx`) sits below the header, so the
 * header still works and another page can be opened. What was caught is reported by `createRoot`'s
 * `onCaughtError`, not here.
 */
import { isUiLocale, type UiLocale } from '@tela/shared'
import { Component, type ReactNode } from 'react'
import { useTranslations } from 'use-intl'
import { detectLocale, MESSAGES } from '../i18n'

type Props = { children: ReactNode; fallback: (retry: () => void) => ReactNode }

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  retry = () => this.setState({ failed: false })

  override render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children
  }
}

/** The failure, in words already chosen: what the page and the root boundary both show. */
export function PageFailed(props: { message: string; retry: string; onRetry: () => void }) {
  return (
    <main
      className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-20 animate-fade"
      data-testid="page-failed"
    >
      <p className="text-[15px] text-ink-2">{props.message}</p>
      <div>
        <button
          type="button"
          onClick={props.onRetry}
          className="inline-block rounded-full border border-ink px-4 py-2 text-[13px] font-medium text-ink hover:bg-ink hover:text-paper"
        >
          {props.retry}
        </button>
      </div>
    </main>
  )
}

/** A page's failure, in the page's language. Try again renders the page afresh. */
export function RouteFailed({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('reader')
  return <PageFailed message={t('loadFailed')} retry={t('retry')} onRetry={onRetry} />
}

/** The language the page is in, or would be, with no provider to ask. */
export function bareLocale(): UiLocale {
  const lang = document.documentElement.lang
  if (isUiLocale(lang)) return lang
  return detectLocale(document.cookie, navigator.languages ?? [navigator.language])
}

/**
 * The whole app's failure, or the boot's, with nothing above it: the words from the catalogues,
 * and Try again a reload, since whatever failed is below everything a re-render could reset.
 */
export function AppFailed({ locale }: { locale: UiLocale }) {
  const words = MESSAGES[locale].reader
  return (
    <PageFailed
      message={words.loadFailed}
      retry={words.retry}
      onRetry={() => window.location.reload()}
    />
  )
}
