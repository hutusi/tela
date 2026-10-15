import { describe, expect, test } from 'bun:test'
import { FOLDER_NAME_MAX } from './constants'
import { folderName, sameFolderName } from './folders'

describe('folder names (ADR 0048)', () => {
  test('are trimmed, their spaces made one, and cut to the longest a name may be', () => {
    expect(folderName('  Craft \t and   software ')).toBe('Craft and software')
    expect(folderName('   ')).toBe('')
    expect(folderName(`${'x'.repeat(FOLDER_NAME_MAX)}yz`)).toHaveLength(FOLDER_NAME_MAX)
  })

  test('are the same name whatever their case, but not whatever their accents', () => {
    expect(sameFolderName('cities', ' Cities ')).toBe(true)
    expect(sameFolderName('城市', '城市')).toBe(true)
    expect(sameFolderName('Cafe', 'Café')).toBe(false)
    expect(sameFolderName('Cities', 'Towns')).toBe(false)
  })
})
