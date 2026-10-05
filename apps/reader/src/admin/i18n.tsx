/**
 * The console's words (ADR 0039): English and Simplified Chinese, written by hand, and Traditional
 * generated from Simplified by `bun run i18n:hant` like the rest of the app. They live in the admin
 * chunk, not the app's catalogues, so the reader's shell never carries them; a French interface
 * reads the console in English. The app's own catalogue stays underneath, for the pages the console
 * borrows (Not found).
 */
import { IntlProvider } from 'use-intl'
import { MESSAGES } from '../i18n'
import { useUi } from '../ui'
import enLibrary from './messages/en/library.json'
import enMembers from './messages/en/members.json'
import enRunning from './messages/en/running.json'
import enShell from './messages/en/shell.json'
import hansLibrary from './messages/zh-Hans/library.json'
import hansMembers from './messages/zh-Hans/members.json'
import hansRunning from './messages/zh-Hans/running.json'
import hansShell from './messages/zh-Hans/shell.json'
import hantLibrary from './messages/zh-Hant/library.json'
import hantMembers from './messages/zh-Hant/members.json'
import hantRunning from './messages/zh-Hant/running.json'
import hantShell from './messages/zh-Hant/shell.json'

const en = { shell: enShell, library: enLibrary, members: enMembers, running: enRunning }

/** The console's languages; each catalogue has the same keys as English (`messages.test.ts`). */
export const ADMIN_MESSAGES: Record<'en' | 'zh-Hans' | 'zh-Hant', typeof en> = {
  en,
  'zh-Hans': { shell: hansShell, library: hansLibrary, members: hansMembers, running: hansRunning },
  'zh-Hant': { shell: hantShell, library: hantLibrary, members: hantMembers, running: hantRunning },
}

export function AdminI18n({ children }: { children: React.ReactNode }) {
  const { locale } = useUi()
  const lang = locale === 'zh-Hans' || locale === 'zh-Hant' ? locale : 'en'
  return (
    <IntlProvider
      locale={lang}
      messages={{ ...MESSAGES[locale], admin: ADMIN_MESSAGES[lang] }}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      {children}
    </IntlProvider>
  )
}
