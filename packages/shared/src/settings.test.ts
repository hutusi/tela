import { describe, expect, test } from 'bun:test'
import {
  defaultSettings,
  isSettingKey,
  parseSetting,
  parseSettingText,
  reached,
  SETTING_KEYS,
} from './settings'

describe('runtime settings (ADR 0056)', () => {
  test('every key has a default its own rule accepts', () => {
    const defaults = defaultSettings()
    for (const key of SETTING_KEYS) {
      expect({ key, ok: parseSetting(key, defaults[key]).ok }).toEqual({ key, ok: true })
    }
  })

  test('a limit is a whole number in range, or null for none', () => {
    expect(parseSetting('member.feedsPerDay', 30)).toEqual({ ok: true, value: 30 })
    expect(parseSetting('member.feedsPerDay', 0)).toEqual({ ok: true, value: 0 })
    expect(parseSetting('member.feedsPerDay', null)).toEqual({ ok: true, value: null })
    expect(parseSetting('member.feedsPerDay', -1).ok).toBe(false)
    expect(parseSetting('member.feedsPerDay', 1.5).ok).toBe(false)
    expect(parseSetting('member.feedsPerDay', '30').ok).toBe(false)
    expect(parseSetting('member.feedsPerDay', 1e9).ok).toBe(false)
  })

  test('a choice is one of its words; percentages are sorted and unique', () => {
    expect(parseSetting('signup.mode', 'open')).toEqual({ ok: true, value: 'open' })
    expect(parseSetting('signup.mode', 'closed').ok).toBe(false)
    expect(parseSetting('alerts.budgetPercents', [100, 80, 80])).toEqual({
      ok: true,
      value: [80, 100],
    })
    expect(parseSetting('alerts.budgetPercents', [0]).ok).toBe(false)
  })

  test('typed text reads as JSON, else as the bare word', () => {
    expect(parseSettingText('signup.mode', 'open')).toEqual({ ok: true, value: 'open' })
    expect(parseSettingText('member.maxSubscriptions', '500')).toEqual({ ok: true, value: 500 })
    expect(parseSettingText('member.maxSubscriptions', 'null')).toEqual({ ok: true, value: null })
    expect(parseSettingText('alerts.budgetPercents', '[50,90]')).toEqual({
      ok: true,
      value: [50, 90],
    })
  })

  test('null never reaches a limit; 0 always has', () => {
    expect(reached(null, 1_000_000)).toBe(false)
    expect(reached(0, 0)).toBe(true)
    expect(reached(20, 19)).toBe(false)
    expect(reached(20, 20)).toBe(true)
  })

  test('only own keys are settings', () => {
    expect(isSettingKey('signup.mode')).toBe(true)
    expect(isSettingKey('constructor')).toBe(false)
  })
})
