/**
 * Before any spec: one member, signed in through the real code flow, subscribed to two fixture
 * feeds (a Chinese blog and an English one) whose posts the sweeps have fetched and whose titles
 * they have translated. Specs start from this member's cookies. The member's lists show every
 * post, read or not (`resetReading` puts it back), so a spec reading a post it read before still
 * finds it; the Unread default is the switch's own specs'. The run's one member reads far more
 * than an ordinary account may in a day, so the member limits are lifted (ADRs 0057, 0063): a
 * spec about a limit sets its own, or answers for tela-api, as the waiting spec does.
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
  setSetting,
  signInRequest,
} from './helpers'

export default async function setup() {
  const context = await request.newContext({ baseURL: BASE })
  for (const key of [
    'member.translationsPerDay',
    'member.feedsPerDay',
    'member.maxSubscriptions',
    'member.unsubscribedPostsPerDay',
  ])
    await setSetting(context, key, null)
  await signInRequest(context, READER)
  for (const path of ['/hutusi.xml', '/jvns.xml']) await addFeed(context, `${FIXTURES}${path}`)
  await cycle(context)
  await setPrefs(context, { 'reader.hide_read': false })
  await context.storageState({ path: STATE_FILE })
  await context.dispose()
}
