/**
 * Settings › Subscriptions' sections drawn on the server (ADR 0048, Tela Lists): what a folder's
 * section and the blogs in none show from `md` up and on a phone. No effect runs in a server
 * render, so no menu opens and nothing is moved; the e2e does that.
 */
import { describe, expect, test } from 'bun:test'
import type { SiteRow } from '@tela/sync'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import {
  type Folder,
  FolderSection,
  type Manage,
  type ManagedRow,
  useFolderDrag,
} from '../src/components/folders-manage'
import { I18n } from '../src/i18n'

const site = (id: number, homeUrl: string): SiteRow => ({
  id,
  homeUrl,
  title: null,
  description: null,
  faviconKey: null,
  primaryLang: 'es',
  listing: 'unlisted',
  owned: false,
  claimed: false,
  readerCount: 0,
  translationOptOut: false,
  seq: 1,
})

const row = (feedId: number, title: string, subscribed = true): ManagedRow => ({
  feedId,
  subscribed,
  title,
  site: site(feedId, `https://${title.toLowerCase().replace(/\s+/g, '')}.example/`),
  cadence: 'weekly',
})

const CITIES: Folder = { id: 'f-cities', name: 'Cities' }
const FOLDERS = [CITIES, { id: 'f-quiet', name: 'Quiet places' }]

function Section({
  phone,
  folder,
  rows,
  heading = true,
}: {
  phone: boolean
  folder: Folder | null
  rows: ManagedRow[]
  heading?: boolean
}) {
  const drag = useFolderDrag(
    () => null,
    () => {},
  )
  const manage: Manage = {
    phone,
    folders: FOLDERS,
    known: FOLDERS,
    move() {},
    openSheet() {},
    rename() {},
    remove() {},
    toggle() {},
    focusMove: { current: null },
    drag,
  }
  return <FolderSection folder={folder} rows={rows} heading={heading} manage={manage} />
}

const render = (node: React.ReactNode) =>
  renderToString(
    <I18n locale="en">
      <MemoryRouter>{node}</MemoryRouter>
    </I18n>,
  )

const count = (html: string, id: string) =>
  html.match(new RegExp(`data-testid="${id}"`, 'g'))?.length ?? 0

describe("a folder's section", () => {
  const rows = [row(1, 'Ciclo Urbano'), row(2, 'Kerb Notes', false)]

  test('from md up: its name and count, Rename and Delete, and rows that drag', () => {
    const html = render(<Section phone={false} folder={CITIES} rows={rows} />)
    expect(html).toContain('data-folder-id="f-cities"')
    expect(html).toContain('>Cities</h3>')
    // The row left from here is listed, dimmed, but not counted.
    expect(html).toContain('1 blog<')
    expect(count(html, 'folder-rename')).toBe(1)
    expect(count(html, 'folder-delete')).toBe(1)
    expect(count(html, 'folder-more')).toBe(0)
    expect(count(html, 'settings-subscription')).toBe(2)
    expect(count(html, 'drag-grip')).toBe(2)
    expect(html.match(/draggable="true"/g)).toHaveLength(2)
    // Each row's folder button names its folder, and says whose it is.
    expect(count(html, 'move-to')).toBe(2)
    expect(html).toContain('aria-label="Folder for Ciclo Urbano: Cities"')
    expect(html).toContain('aria-haspopup="menu"')
    // The address line carries the language, as the design draws it.
    expect(html).toContain('ciclourbano.example · ES · weekly')
    expect(html).toMatch(/opacity-55[^"]*" data-testid="settings-subscription" data-feed-id="2"/)
    expect(html).toContain('>Subscribe<')
  })

  test('on a phone: ··· in place of Rename and Delete, and nothing drags', () => {
    const html = render(<Section phone folder={CITIES} rows={rows} />)
    expect(count(html, 'folder-more')).toBe(1)
    expect(html).toContain('aria-label="Options for Cities"')
    // Behind ···, which is closed.
    expect(count(html, 'folder-rename')).toBe(0)
    expect(count(html, 'drag-grip')).toBe(0)
    expect(html).not.toContain('draggable="true"')
    expect(html).toContain('aria-haspopup="dialog"')
  })

  test('empty, says how a blog gets there, by the way the page offers', () => {
    expect(render(<Section phone={false} folder={CITIES} rows={[]} />)).toContain(
      'Drag blogs here.',
    )
    expect(render(<Section phone folder={CITIES} rows={[]} />)).toContain(
      'A blog’s folder button moves it here.',
    )
  })
})

describe('the blogs in no folder', () => {
  test('are named once there are folders, and have no Rename or Delete', () => {
    const html = render(<Section phone={false} folder={null} rows={[row(3, 'Harbour')]} />)
    expect(html).toContain('data-folder-id=""')
    expect(html).toContain('Not in a folder')
    expect(count(html, 'folder-rename')).toBe(0)
    expect(count(html, 'folder-delete')).toBe(0)
    expect(html).toContain('aria-label="Folder for Harbour: No folder"')
  })

  test('with no folders at all, are the list as it always was, unnamed', () => {
    const html = render(
      <Section phone={false} folder={null} rows={[row(3, 'Harbour')]} heading={false} />,
    )
    expect(html).not.toContain('Not in a folder')
    expect(count(html, 'settings-subscription')).toBe(1)
  })

  test('none left, say every blog is in a folder', () => {
    expect(render(<Section phone={false} folder={null} rows={[]} />)).toContain(
      'Every blog is in a folder.',
    )
  })
})
