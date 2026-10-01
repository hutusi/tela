/**
 * How the member reads, beyond typography (`typography.ts`): synced prefs, so every device reads
 * the same way. Keys are lowercase, as the protocol requires (`PREF_KEY`). A value this build
 * does not understand reads as the default, never as nonsense.
 */
import type { Tables } from '@tela/sync'
import { useMemo } from 'react'
import { type ReadingMode, readingModeParam } from './href'

export const PREF_KEYS = {
  /** The mode a URL without one opens a translated post in. */
  mode: 'reader.mode',
  /** Opening a post reads it (default); off, it stays unread until marked. */
  markOnOpen: 'reader.mark_on_open',
  /** Lists show unread posts only; liked ones are always kept. */
  hideRead: 'reader.hide_read',
  /** A foreign post asks for its translation as it opens (default); off, only when asked. */
  autoTranslate: 'translate.auto',
  /** Languages the member reads comfortably: never translated, shown in the original. */
  never: 'translate.never',
} as const

export type ReadingPrefs = {
  mode: ReadingMode
  markOnOpen: boolean
  hideRead: boolean
  autoTranslate: boolean
  /** Exact language tags (zh-Hans and zh-Hant are two). Stable while the pref is unchanged. */
  never: readonly string[]
}

const NONE: readonly string[] = []
const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
const tags = (value: unknown): readonly string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') && value.length > 0
    ? (value as string[])
    : NONE

export function readingPrefsOf(t: Tables): ReadingPrefs {
  const get = (key: string) => t.prefs.get(key)?.value
  return {
    mode: readingModeParam((get(PREF_KEYS.mode) as string | undefined) ?? null) ?? 'side',
    markOnOpen: flag(get(PREF_KEYS.markOnOpen), true),
    hideRead: flag(get(PREF_KEYS.hideRead), false),
    autoTranslate: flag(get(PREF_KEYS.autoTranslate), true),
    never: tags(get(PREF_KEYS.never)),
  }
}

/**
 * The prefs as one object that changes only when one of them does: effects and memos can depend
 * on it (AGENTS.md: a fresh value every render loops a layout effect that sets state from it).
 */
export function useReadingPrefs(t: Tables): ReadingPrefs {
  // `never` is the stored array itself, so its identity changes only with the pref.
  const { mode, markOnOpen, hideRead, autoTranslate, never } = readingPrefsOf(t)
  return useMemo(
    () => ({ mode, markOnOpen, hideRead, autoTranslate, never }),
    [mode, markOnOpen, hideRead, autoTranslate, never],
  )
}
