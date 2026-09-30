/** The keyboard layer (ADR 0026): j and k through the list, Esc to close, focus back on the row. */
import { expect, type Page, test } from '@playwright/test'
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

/** Julia Evans' list with its first article open by `j`; the first two rows' ids. */
async function openFirst(page: Page): Promise<{ first: string; second: string }> {
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
  await expect(page).toHaveURL(/feed=\d+$/)
  await expect(page.getByTestId('article-row').first()).toContainText('Julia Evans')
  const rows = page.getByTestId('article-row')
  const first = (await rows.nth(0).getAttribute('data-article-id')) ?? ''
  const second = (await rows.nth(1).getAttribute('data-article-id')) ?? ''
  await page.keyboard.press('j')
  await expect(page).toHaveURL(new RegExp(`article=${first}$`))
  await expect(page.getByTestId('reader')).toBeVisible()
  return { first, second }
}

const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('data-article-id'))

test('Esc focuses the row it closed, when the render between j and Esc is committed', async ({
  page,
}) => {
  const { first, second } = await openFirst(page)
  // k and Esc land inside the commit that marks the second row active, after its DOM changed and
  // before its effects ran: the render that shows the second article is committed, and the one
  // that shows the list (k and Esc together) comes after it. The close came from the first.
  await page.evaluate((second) => {
    const original = Element.prototype.setAttribute
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      original.call(this, name, value)
      if (name !== 'data-active' || value !== '1') return
      if (this.getAttribute('data-article-id') !== second) return
      Element.prototype.setAttribute = original
      for (const key of ['k', 'Escape']) {
        // On the body, as a key pressed with nothing focused is: the listener is on window.
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        )
      }
    }
  }, second)
  await page.keyboard.press('j')
  await expect(page).not.toHaveURL(/article=/)
  await expect.poll(() => focused(page)).toBe(first)
})

test('Back to a list a close left focuses the row just read, not the one closed', async ({
  page,
}) => {
  const { first, second } = await openFirst(page)
  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/article=/)
  await expect.poll(() => focused(page)).toBe(first)
  // History is now [list, first, list closed from first, second]; Back returns to the entry the
  // close pushed, and the article left was the second.
  await page.locator(`[data-testid="article-row"][data-article-id="${second}"]`).click()
  await expect(page).toHaveURL(new RegExp(`article=${second}$`))
  await expect(page.getByTestId('reader')).toBeVisible()
  await page.goBack()
  await expect(page).not.toHaveURL(/article=/)
  await expect.poll(() => focused(page)).toBe(second)
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

test('Esc in the account menu closes the menu, not the article, and gives the avatar focus', async ({
  page,
}) => {
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('article-row').first().click()
  await expect(page.getByTestId('reader')).toBeVisible()
  const button = page.getByTestId('account-menu')
  await button.click()
  await expect(page.getByTestId('account-panel')).toBeVisible()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('account-panel')).toHaveCount(0)
  await expect(page.getByTestId('reader')).toBeVisible()
  await expect(page).toHaveURL(/article=\d+/)
  await expect(button).toBeFocused()
  // A click elsewhere closes it too.
  await button.click()
  await page.getByTestId('sidebar').getByText('Library').click()
  await expect(page.getByTestId('account-panel')).toHaveCount(0)
})
