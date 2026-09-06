import { afterEach, describe, expect, test } from 'bun:test'
import robots from './robots'

afterEach(() => {
  delete process.env.TELA_PRIVATE_BETA
})

describe('robots.txt', () => {
  test('turns crawlers away while Tela is in private testing', () => {
    process.env.TELA_PRIVATE_BETA = '1'
    expect(robots()).toEqual({ rules: { userAgent: '*', disallow: '/' } })
  })

  test('welcomes them once the flag is gone', () => {
    expect(robots()).toEqual({ rules: { userAgent: '*', allow: '/' } })
    process.env.TELA_PRIVATE_BETA = '0'
    expect(robots()).toEqual({ rules: { userAgent: '*', allow: '/' } })
  })
})
