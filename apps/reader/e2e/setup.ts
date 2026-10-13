/**
 * Before any spec: one member, signed in through the real code flow, subscribed to two fixture
 * feeds (a Chinese blog and an English one) whose posts the sweeps have fetched and whose titles
 * they have translated. Specs start from this member's cookies. The member's lists show every
 * post, read or not (`resetReading` puts it back), so a spec reading a post it read before still
 * finds it; the Unread default is the switch's own specs'.
 */
import { request } from '@playwright/test'
import {
  addFeed,
  BASE,
  cycle,
  FIXTURES,
  READER,
  STATE_FILE,
  setPrefs,
  signInRequest,
} from './helpers'

export default async function setup() {
  const context = await request.newContext({ baseURL: BASE })
  await signInRequest(context, READER)
  for (const path of ['/hutusi.xml', '/jvns.xml']) await addFeed(context, `${FIXTURES}${path}`)
  await cycle(context)
  await setPrefs(context, { 'reader.hide_read': false })
  await context.storageState({ path: STATE_FILE })
  await context.dispose()
}
