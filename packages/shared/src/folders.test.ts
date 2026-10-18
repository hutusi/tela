import { describe, expect, test } from 'bun:test'
import { FOLDER_NAME_MAX } from './constants'
import { folderName, sameFolderName } from './folders'

describe('folder names (ADR 0048)', () => {
  test('are trimmed, their spaces made one, and cut to the longest a name may be', () => {
    expect(folderName('  Craft \t and   software ')).toBe('Craft and software')
    expect(folderName('   ')).toBe('')
    expect(folderName('\u0000Cities\u007f')).toBe('Cities')
    expect(folderName(`${'x'.repeat(FOLDER_NAME_MAX)}yz`)).toHaveLength(FOLDER_NAME_MAX)
  })

  test('never end in half an emoji', () => {
    // 59 letters then an emoji: its two UTF-16 units straddle the 60th.
    const name = folderName(`${'a'.repeat(59)}😀`)
    expect(name).toBe('a'.repeat(59))
    expect(folderName(`${'a'.repeat(58)}😀`)).toBe(`${'a'.repeat(58)}😀`)
  })

  test('are the same name whatever their case, but not whatever their accents', () => {
    expect(sameFolderName('cities', ' Cities ')).toBe(true)
    expect(sameFolderName('城市', '城市')).toBe(true)
    expect(sameFolderName('Cafe', 'Café')).toBe(false)
    expect(sameFolderName('Cities', 'Towns')).toBe(false)
  })
})
