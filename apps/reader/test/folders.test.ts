/** Settings › Subscriptions in folders (ADR 0048): grouping its rows, naming, and what Undo makes. */
import { describe, expect, test } from 'bun:test'
import { MAX_FOLDERS } from '@tela/shared'
import {
  applyMutation,
  applyPull,
  emptyTables,
  type FeedFolderRow,
  type FolderRow,
  type Tables,
  view,
} from '@tela/sync'
import { canMakeFolder, checkFolderName, filedIn, folderWith, groupRows } from '../src/lib/folders'
import { NOW, pull, sub } from './rows'

const folder = (id: string, name: string): FolderRow => ({
  id,
  name,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  seq: 1,
})
const filed = (feedId: number, folderId: string | null): FeedFolderRow => ({
  feedId,
  folderId,
  updatedAt: 1,
  seq: 1,
})

function tables(rows: Parameters<typeof pull>[1]): Tables {
  return view(applyPull({ cursor: 0, tables: emptyTables() }, pull(1, rows, true)), [])
}

describe("Settings' rows by folder", () => {
  const t = tables({
    // 4 was left from the page: its row is still listed, dimmed.
    subscriptions: [sub(1), sub(2), sub(3), sub(4, { deletedAt: 5 })],
    folders: [folder('f-towns', 'towns'), folder('f-cities', 'Cities'), folder('f-bare', 'Bare')],
    // 3's folder was deleted elsewhere, and the pull that unfiles it has not come yet.
    feedFolders: [
      filed(1, 'f-towns'),
      filed(2, 'f-cities'),
      filed(3, 'f-gone'),
      filed(4, 'f-towns'),
    ],
  })
  // As the page orders them, by title; grouping keeps that order.
  const rows = [
    { feedId: 4, title: 'Alpha' },
    { feedId: 2, title: 'Beta' },
    { feedId: 3, title: 'Gamma' },
    { feedId: 1, title: 'Zeta' },
  ]

  test('are the folders by name, each with its rows in order, then the rows in none', () => {
    const grouped = groupRows(t, NOW, rows)
    expect(grouped.folders.map((f) => [f.name, f.rows.map((r) => r.title)])).toEqual([
      ['Bare', []],
      ['Cities', ['Beta']],
      ['towns', ['Alpha', 'Zeta']],
    ])
    expect(grouped.unfiled.map((r) => r.title)).toEqual(['Gamma'])
  })

  test('keep a dimmed row in its folder, so taking it back leaves it there', () => {
    const towns = groupRows(t, NOW, rows).folders.find((f) => f.id === 'f-towns')
    expect(towns?.rows.map((r) => r.feedId)).toContain(4)
  })

  test('follow a move as the device predicts it', () => {
    const moved = applyMutation(t, {
      type: 'fileFeed',
      feedId: 1,
      folderId: null,
      mid: 'm1',
      at: 10,
    })
    const grouped = groupRows(moved, NOW, rows)
    expect(grouped.unfiled.map((r) => r.feedId)).toEqual([3, 1])
  })
})

describe("a folder's name", () => {
  const folders = [
    { id: 'a', name: 'Cities' },
    { id: 'b', name: 'Café' },
  ]

  test('is kept trimmed, its spaces made one', () => {
    expect(checkFolderName('  Craft   and  code ', folders)).toEqual({ ok: 'Craft and code' })
  })

  test('says nothing when empty', () => {
    expect(checkFolderName('   ', folders)).toEqual({ empty: true })
  })

  test('is refused when the member has it already, whatever its case, naming the one they have', () => {
    expect(checkFolderName(' cities', folders)).toEqual({ taken: 'Cities' })
    // Accents make another word.
    expect(checkFolderName('Cafe', folders)).toEqual({ ok: 'Cafe' })
  })

  test('renaming, is no clash with its own, so a folder may change only its case', () => {
    expect(checkFolderName('CITIES', folders, 'a')).toEqual({ ok: 'CITIES' })
    expect(checkFolderName('café', folders, 'a')).toEqual({ taken: 'Café' })
  })
})

describe('folders to make', () => {
  test('stop at the most a member may have', () => {
    const some = new Map([['a', folder('a', 'A')]])
    expect(canMakeFolder({ folders: some })).toBe(true)
    const full = new Map(
      Array.from({ length: MAX_FOLDERS }, (_, i) => [`f${i}`, folder(`f${i}`, `F${i}`)] as const),
    )
    expect(canMakeFolder({ folders: full })).toBe(false)
  })

  test("a folder's blogs are every one filed in it, followed or not", () => {
    const t = tables({
      subscriptions: [sub(1), sub(2, { deletedAt: 5 })],
      folders: [folder('f-a', 'A')],
      feedFolders: [filed(1, 'f-a'), filed(2, 'f-a'), filed(3, null), filed(4, 'f-b')],
    })
    expect(filedIn(t, 'f-a')).toEqual([1, 2])
  })

  test('made with blogs in it, as one change, under a new id', () => {
    expect(folderWith('Cities', [3, 1], 'f-new')).toEqual([
      { type: 'putFolder', id: 'f-new', name: 'Cities' },
      { type: 'fileFeed', feedId: 3, folderId: 'f-new' },
      { type: 'fileFeed', feedId: 1, folderId: 'f-new' },
    ])
    const [put] = folderWith('Cities', [])
    expect(put).toMatchObject({ type: 'putFolder', name: 'Cities' })
    expect(put && 'id' in put ? put.id : '').toMatch(/^[A-Za-z0-9-]{8,64}$/)
  })

  test('again after its deletion was sent, puts the same blogs back in one of the same name', () => {
    let t = tables({
      subscriptions: [sub(1), sub(2)],
      folders: [folder('f-a', 'Cities')],
      feedFolders: [filed(1, 'f-a'), filed(2, 'f-a')],
    })
    const blogs = filedIn(t, 'f-a')
    t = applyMutation(t, { type: 'deleteFolder', id: 'f-a', mid: 'm1', at: 10 })
    expect(filedIn(t, 'f-a')).toEqual([])
    folderWith('Cities', blogs, 'f-again').forEach((m, i) => {
      t = applyMutation(t, { ...m, mid: `u${i}`, at: 11 + i })
    })
    expect([...t.folders.values()].map((f) => [f.id, f.name])).toEqual([['f-again', 'Cities']])
    expect(filedIn(t, 'f-again')).toEqual([1, 2])
  })
})
