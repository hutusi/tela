/**
 * WebSub (ADR 0011): tela-jobs subscribes at a feed's hub, the callback verifies intent through
 * tela-web, and a signed ping is accepted while a forged one is not.
 */
import { expect, test } from '@playwright/test'
import { FIXTURES, keepCycling } from './helpers'

type HubState = {
  subscriptions: {
    mode: string
    topic: string
    callback: string
    leaseSeconds: number
    verifyStatus: number | null
    verified: boolean
  }[]
}

test('the sweeps subscribe at the feed’s hub; the callback verifies intent and accepts signed pings', async ({
  page,
  request,
}) => {
  await page.goto('/add')
  await page.getByTestId('feed-url').fill(`${FIXTURES}/hubbed.xml`)
  await page.getByTestId('find-feeds').click()
  await page.getByTestId('feed-candidates').getByTestId('subscribe').first().click()
  await expect(page).toHaveURL(/\/reading\?feed=\d+/)
  const feedId = page.url().match(/feed=(\d+)/)?.[1]

  const hub = async () => (await (await request.get(`${FIXTURES}/__hub`)).json()) as HubState
  const stop = keepCycling(page)
  try {
    await expect
      .poll(async () => (await hub()).subscriptions.filter((s) => s.verified).length, {
        timeout: 45_000,
      })
      .toBeGreaterThan(0)
  } finally {
    stop()
  }
  const state = await hub()
  const i = state.subscriptions.findIndex((s) => s.verified)
  const sub = state.subscriptions[i]
  expect(sub).toMatchObject({
    mode: 'subscribe',
    topic: `${FIXTURES}/hubbed.xml`,
    verifyStatus: 200,
  })
  expect(sub?.callback).toMatch(new RegExp(`/api/websub/${feedId}$`))

  const ping = (await (await request.post(`${FIXTURES}/__hub/notify?i=${i}`)).json()) as {
    status: number
  }
  expect(ping.status).toBe(204)

  const forged = await request.post(sub?.callback ?? '', {
    headers: { 'x-hub-signature': `sha256=${'ab'.repeat(32)}`, 'content-type': 'text/xml' },
    data: '<feed/>',
  })
  expect(forged.status()).toBe(403)
  const unknown = await request.get(
    '/api/websub/999999?hub.mode=subscribe&hub.topic=x&hub.challenge=c',
  )
  expect(unknown.status()).toBe(404)
  const wrongTopic = await request.get(
    `${sub?.callback}?hub.mode=subscribe&hub.topic=http://x/other&hub.challenge=c`,
  )
  expect(wrongTopic.status()).toBe(404)
})
