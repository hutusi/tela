/**
 * A view that throws as it renders: its page shows the failure with Try again, the header above
 * it still works, and the error is reported to tela-api (`/api/client-errors`). The throw is
 * forced by an answer no tela-api would give, Discover's Blogs with a blog that is null.
 */
import { expect, test } from '@playwright/test'
import { synced } from './helpers'

test('a page that throws shows Try again below a header that still works, and says so', async ({
  page,
}) => {
  await page.route(/\/api\/v1\/public\/discover(\?|$)/, (route) =>
    route.fulfill({
      json: { sites: [null], languages: [], total: 1, page: 1, pageSize: 60 },
    }),
  )
  await page.goto('/reading')
  await synced(page)
  await expect(page.getByTestId('article-row').first()).toBeVisible()

  const reported = page.waitForRequest(
    (r) => r.url().endsWith('/api/client-errors') && r.method() === 'POST',
  )
  await page.getByTestId('nav-discover').click()
  await page.getByTestId('discover-tab-blogs').click()
  await expect(page).toHaveURL(/\/discover\/blogs/)
  const failed = page.getByTestId('page-failed')
  await expect(failed).toContainText('Something went wrong loading this.')
  await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible()
  const body = (await reported).postDataJSON() as { kind: string; path: string; message: string }
  expect(body).toMatchObject({ kind: 'boundary', path: '/discover/blogs' })
  expect(body.message).toContain('TypeError')

  // The header is above the failure and still takes the member elsewhere, where all is well.
  await page.getByTestId('nav-reading').click()
  await expect(page).toHaveURL(/\/reading/)
  await expect(page.getByTestId('page-failed')).toHaveCount(0)
  await expect(page.getByTestId('article-row').first()).toBeVisible()
})
