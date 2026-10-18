/**
 * Settings › Subscriptions drawn on the server (ADRs 0048, 0049, Tela Lists): a folder's section
 * below `lg`, and the manager from `lg` up as it first shows. No effect runs in a server render, so
 * no menu opens and nothing is ticked or moved; the e2e does that.
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
} from '../src/components/folders-manage'
import { SubscriptionsManager } from '../src/components/subscriptions-manager'
import { I18n } from '../src/i18n'

const DAY = 86_400_000
const NOW = 400 * DAY

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

const row = (feedId: number, title: string, over: Partial<ManagedRow> = {}): ManagedRow => ({
  feedId,
  title,
  site: site(feedId, `https://${title.toLowerCase().replace(/\s+/g, '')}.example/`),
  feedUrl: undefined,
  folderId: null,
  latest: NOW - 3 * DAY,
  dead: false,
  ...over,
})

const CITIES: Folder = { id: 'f-cities', name: 'Cities' }
const FOLDERS = [CITIES, { id: 'f-quiet', name: 'Quiet places' }]

const activity = (r: ManagedRow) =>
  r.dead ? 'Not updating' : r.latest === null ? 'No posts yet' : `${(NOW - r.latest) / DAY}d`

function Section({
  folder,
  rows,
  heading = true,
  filtering = false,
}: {
  folder: Folder | null
  rows: ManagedRow[]
  heading?: boolean
  filtering?: boolean
}) {
  const manage: Manage = {
    folders: FOLDERS,
    known: FOLDERS,
    openSheet() {},
    rename() {},
    remove() {},
    unsubscribe() {},
    activity,
    focusMove: { current: null },
  }
  return (
    <FolderSection
      folder={folder}
      rows={rows}
      heading={heading}
      filtering={filtering}
      manage={manage}
    />
  )
}

const render = (node: React.ReactNode) =>
  renderToString(
    <I18n locale="en">
      <MemoryRouter>{node}</MemoryRouter>
    </I18n>,
  )

const count = (html: string, id: string) =>
  html.match(new RegExp(`data-testid="${id}"`, 'g'))?.length ?? 0

describe("below lg, a folder's section", () => {
  const rows = [row(1, 'Ciclo Urbano', { folderId: CITIES.id }), row(2, 'Kerb Notes')]

  test('its name and count, ··· for Rename and Delete, and rows that do not drag', () => {
    const html = render(<Section folder={CITIES} rows={rows} />)
    expect(html).toContain('data-folder-id="f-cities"')
    expect(html).toContain('>Cities</h3>')
    expect(html).toContain('2 blogs<')
    expect(count(html, 'folder-more')).toBe(1)
    expect(html).toContain('aria-label="Options for Cities"')
    // Behind ···, which is closed.
    expect(count(html, 'folder-rename')).toBe(0)
    expect(html).not.toContain('draggable="true"')
    expect(count(html, 'settings-subscription')).toBe(2)
    // Each row's folder button names its folder, says whose it is, and opens a sheet.
    expect(html).toContain('aria-label="Folder for Ciclo Urbano: Cities"')
    expect(html).toContain('aria-haspopup="dialog"')
  })

  test("a row's second line is its address, language and latest post, and it unsubscribes", () => {
    const html = render(
      <Section
        folder={null}
        heading={false}
        rows={[
          row(1, 'Ciclo Urbano'),
          row(2, 'Gone', { dead: true }),
          row(3, 'New', { latest: null }),
        ]}
      />,
    )
    expect(html).toContain('ciclourbano.example · ES · 3d')
    expect(html).toContain('gone.example · ES · Not updating')
    expect(html).toContain('new.example · ES · No posts yet')
    expect(count(html, 'settings-unsubscribe')).toBe(3)
    expect(html).not.toContain('>Subscribe<')
  })

  test('empty, says how a blog gets there; emptied by the filter, is not shown', () => {
    expect(render(<Section folder={CITIES} rows={[]} />)).toContain(
      'A blog’s folder button moves it here.',
    )
    expect(render(<Section folder={CITIES} rows={[]} filtering />)).toBe('')
  })

  test('the blogs in none: named once there are folders, unnamed without', () => {
    const named = render(<Section folder={null} rows={[row(3, 'Harbour')]} />)
    expect(named).toContain('Not in a folder')
    expect(count(named, 'folder-more')).toBe(0)
    const plain = render(<Section folder={null} rows={[row(3, 'Harbour')]} heading={false} />)
    expect(plain).not.toContain('Not in a folder')
    expect(render(<Section folder={null} rows={[]} />)).toContain('Every blog is in a folder.')
  })
})

describe('from lg up, the manager as it first shows', () => {
  const rows = [
    row(1, 'Ciclo Urbano', { folderId: CITIES.id }),
    row(2, 'Kerb Notes'),
    row(3, 'Atlas of Hums', { latest: NOW - 200 * DAY }),
  ]
  const manager = (over: Partial<Parameters<typeof SubscriptionsManager>[0]> = {}) =>
    render(
      <SubscriptionsManager
        rows={rows}
        folders={FOLDERS}
        known={FOLDERS}
        canMake
        folderOf={() => null}
        activity={activity}
        now={NOW}
        actions={{
          move() {},
          unsubscribe() {},
          create: () => null,
          rename() {},
          remove() {},
        }}
        {...over}
      />,
    )

  test('its places: All blogs (current), Not in a folder, and each folder, with counts', () => {
    const html = manager()
    expect(count(html, 'place')).toBe(4)
    expect(html).toMatch(/aria-current="true"[^>]*data-place="all"/)
    expect(html).toMatch(/data-place=""[\s\S]*?Not in a folder[\s\S]*?>2</)
    expect(html).toMatch(/data-place="f-cities"[\s\S]*?Cities[\s\S]*?>1</)
    // No accent dot: everywhere else in Tela an accent dot means unread.
    expect(html).not.toContain('rounded-full bg-accent')
    expect(html).toContain('Folders are private and travel with your OPML export.')
  })

  test('every blog by name, with its folder and latest post, quiet ones muted', () => {
    const html = manager()
    expect(html).toContain('>All blogs</h3>')
    expect(html).toContain('3 blogs<')
    const order = [
      ...html.matchAll(/data-testid="settings-subscription" data-feed-id="(\d+)"/g),
    ].map((m) => m[1])
    expect(order).toEqual(['3', '1', '2'])
    expect(html).toContain('aria-label="Folder for Ciclo Urbano: Cities"')
    expect(html).toContain('aria-label="Folder for Kerb Notes: No folder"')
    expect(html).toMatch(/text-muted[^"]*" data-testid="latest-post">200d</)
    expect(html).toMatch(/text-ink-2[^"]*" data-testid="latest-post">3d</)
  })

  test('not in Select mode: rows drag, and there are no tick boxes', () => {
    const html = manager()
    expect(html.match(/draggable="true"/g)).toHaveLength(3)
    expect(count(html, 'subscription-tick')).toBe(0)
    expect(count(html, 'select-all')).toBe(0)
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('>Select<')
  })

  test('at the limit, + is off and says why', () => {
    const html = manager({ canMake: false })
    expect(html).toMatch(
      /aria-describedby="[^"]+"[^>]*aria-label="New folder"[^>]*disabled=""|disabled=""[^>]*aria-describedby/,
    )
    expect(count(html, 'new-folder-limit')).toBe(1)
  })

  test('with no subscriptions, says so, and Select is off', () => {
    const html = manager({ rows: [] })
    expect(html).toContain('No subscriptions yet.')
    expect(html).toMatch(/disabled=""[^>]*data-testid="select-toggle"/)
  })
})
