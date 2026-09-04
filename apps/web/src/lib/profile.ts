import { getProfile, type Profile } from '@tela/db/queries'
import { cache } from 'react'
import { getSessionUser } from './auth'
import { getDb } from './platform/db'

/** The signed-in member's profile row, once per request. */
export const getCurrentProfile = cache(async (): Promise<Profile | null> => {
  const user = await getSessionUser()
  if (!user) return null
  try {
    return await getProfile(await getDb(), user.id)
  } catch {
    return null
  }
})
