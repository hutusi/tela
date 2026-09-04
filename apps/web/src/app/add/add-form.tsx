'use client'

import { useTranslations } from 'next-intl'
import { useActionState } from 'react'
import {
  type DiscoverState,
  discoverAction,
  type ImportState,
  importOpmlAction,
  subscribeAction,
} from './actions'

const initialDiscover: DiscoverState = { candidates: null, error: null, query: '' }
const initialImport: ImportState = { imported: null, error: null }

export function AddFeedForm() {
  const t = useTranslations('add')
  const [state, action, pending] = useActionState(discoverAction, initialDiscover)
  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex gap-2">
        <input
          name="url"
          type="text"
          required
          defaultValue={state.query}
          placeholder={t('placeholder')}
          className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2.5 outline-none focus:border-muted"
          data-testid="feed-url"
        />
        <button
          type="submit"
          disabled={pending}
          className="whitespace-nowrap rounded-full bg-ink px-4 py-2.5 font-medium text-paper hover:brightness-125 disabled:opacity-60"
          data-testid="find-feeds"
        >
          {pending ? t('searching') : t('find')}
        </button>
      </form>
      {state.error ? (
        <p className="text-sm text-[oklch(0.5_0.15_25)]">{t(`errors.${state.error}`)}</p>
      ) : null}
      {state.candidates && state.candidates.length === 0 ? (
        <p className="text-sm text-muted">{t('none')}</p>
      ) : null}
      {state.candidates && state.candidates.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="feed-candidates">
          {state.candidates.map((c) => (
            <li
              key={c.url}
              className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{c.title ?? c.url}</div>
                <div className="truncate text-[12.5px] text-muted">
                  {c.url} · {c.format.toUpperCase()} · {t('items', { n: c.itemCount })}
                </div>
              </div>
              <form action={subscribeAction}>
                <input type="hidden" name="feedUrl" value={c.url} />
                <button
                  type="submit"
                  className="rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-paper hover:brightness-125"
                  data-testid="subscribe"
                >
                  {t('subscribe')}
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function OpmlForm() {
  const t = useTranslations('add')
  const [state, action, pending] = useActionState(importOpmlAction, initialImport)
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input
        name="opml"
        type="file"
        accept=".opml,.xml,text/xml,application/xml,text/x-opml"
        required
        className="text-sm"
        data-testid="opml-file"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-full border border-ink px-4 py-2 font-medium hover:bg-ink hover:text-paper disabled:opacity-60"
        data-testid="opml-import"
      >
        {t('import')}
      </button>
      {state.imported !== null ? (
        <span className="text-sm text-ink-2" data-testid="opml-result">
          {t('imported', { n: state.imported })}
        </span>
      ) : null}
      {state.error ? (
        <span className="text-sm text-[oklch(0.5_0.15_25)]">{t(`errors.${state.error}`)}</span>
      ) : null}
    </form>
  )
}
