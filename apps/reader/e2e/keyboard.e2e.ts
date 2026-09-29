/** The keyboard layer (ADR 0026): j and k through the list, Esc to close, focus back on the row. */
import { expect, test } from '@playwright/test'
import { synced } from './helpers'

test('j and k step through the list, and Esc closes back to the row', async ({ page }) => {
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
  await expect(page).toHaveURL(/feed=\d+$/)
  // This feed's own list, not the one it replaced.
  await expect(page.getByTestId('article-row').first()).toContainText('Julia Evans')
  const rows = page.getByTestId('article-row')
  const first = await rows.nth(0).getAttribute('data-article-id')
  const second = await rows.nth(1).getAttribute('data-article-id')

  await page.keyboard.press('j')
  await expect(page).toHaveURL(new RegExp(`article=${first}$`))
  await expect(page.getByTestId('reader')).toBeVisible()
  await page.keyboard.press('j')
  await expect(page).toHaveURL(new RegExp(`article=${second}$`))
  await page.keyboard.press('k')
  await expect(page).toHaveURL(new RegExp(`article=${first}$`))

  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/article=/)
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-article-id')))
    .toBe(first)
  // And from the row, j carries on.
  await page.keyboard.press('j')
  await expect(page).toHaveURL(/article=\d+$/)
})

test('? lists the keys; Esc in a popover closes the popover, not the article', async ({ page }) => {
  await page.goto('/reading')
  await synced(page)
  await page.keyboard.press('?')
  await expect(page.getByTestId('shortcuts')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('shortcuts')).toHaveCount(0)

  await page.getByTestId('article-row').first().click()
  await page.getByTestId('recommend-button').click()
  await page.getByTestId('recommend-note').press('Escape')
  await expect(page.getByTestId('recommend-popover')).toHaveCount(0)
  await expect(page.getByTestId('reader')).toBeVisible()
  // Typing a j in a field is typing, not a shortcut.
  await page.getByTestId('search-input').focus()
  await page.keyboard.press('j')
  await expect(page.getByTestId('reader')).toBeVisible()
  await expect(page).toHaveURL(/article=\d+/)
})
