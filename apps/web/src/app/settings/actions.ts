'use server'

import { updateProfile } from '@tela/db/queries'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'

export type SettingsState = { saved: boolean; error: string | null }

export async function updateProfileAction(
  _prev: SettingsState,
  form: FormData,
): Promise<SettingsState> {
  const user = await requireUser('/settings')
  const result = await updateProfile(await getDb(), user.id, {
    handle: String(form.get('handle') ?? ''),
    displayName: String(form.get('displayName') ?? ''),
    bio: String(form.get('bio') ?? ''),
    publicSubscriptions: form.get('publicSubscriptions') === 'on',
  })
  if (result !== 'ok') return { saved: false, error: result }
  revalidatePath('/', 'layout')
  return { saved: true, error: null }
}
