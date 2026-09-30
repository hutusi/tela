/**
 * Before any spec: one member, signed in through the real code flow, subscribed to two fixture
 * feeds (a Chinese blog and an English one) whose posts the sweeps have fetched and whose titles
 * they have translated. Specs start from this member's cookies.
 */
import { request } from '@playwright/test'
import { addFeed, BASE, cycle, FIXTURES, READER, STATE_FILE, signInRequest } from './helpers'

export default async function setup() {
  const context = await request.newContext({ baseURL: BASE })
  await signInRequest(context, READER)
  for (const path of ['/hutusi.xml', '/jvns.xml']) await addFeed(context, `${FIXTURES}${path}`)
  await cycle(context)
  await context.storageState({ path: STATE_FILE })
  await context.dispose()
}
