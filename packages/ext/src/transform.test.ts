import { describe, expect, test } from 'bun:test'
import {
  askedTypes,
  cursorNeedsReset,
  decodeCursor,
  encodeCursor,
  V1_DEFAULT_TYPES,
  V1_ROW_TYPES,
  type V1RowType,
} from './transform'

describe('the row types a pull covers', () => {
  test('without `types`, the fourteen v1 began with, whatever it learns later', () => {
    expect(askedTypes(undefined)).toEqual([...V1_DEFAULT_TYPES])
    expect(askedTypes('')).toEqual([...V1_DEFAULT_TYPES])
    expect(V1_DEFAULT_TYPES).toHaveLength(14)
  })

  test('a cursor made without `types` stays good when v1 adds a row type', () => {
    const cursor = encodeCursor({ seq: 42, lang: 'en', types: askedTypes(undefined) ?? [] })
    // v1 grows by one type: an app that names none must not start over for it.
    const grown = [...V1_ROW_TYPES, 'blogrolls'] as unknown as readonly V1RowType[]
    const types = askedTypes(undefined, grown) ?? []
    expect(types as string[]).not.toContain('blogrolls')
    expect(cursorNeedsReset(decodeCursor(cursor), 'en', types)).toBe(false)
    // One that asks for the new type by name does start over: its cursor never covered it.
    const asked = askedTypes('articles,blogrolls', grown)
    expect(asked as string[] | null).toEqual(['articles', 'blogrolls'])
    expect(cursorNeedsReset(decodeCursor(cursor), 'en', asked ?? [])).toBe(true)
  })

  test('names it does not know are no types', () => {
    expect(askedTypes('articles,claims')).toBe(null)
    expect(askedTypes(' titles , articles')).toEqual(['articles', 'titles'])
  })
})
