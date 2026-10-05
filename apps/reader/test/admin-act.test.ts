/**
 * Acting in the admin console: which actions ask first, how their buttons look, and what the
 * toast, History and the health line say, in the console's own English and Simplified Chinese.
 */
import { describe, expect, test } from 'bun:test'
import {
  ACTION_CONFIRM,
  ADMIN_ACTIONS,
  type AdminHealth,
  type AdminRowBase,
} from '@tela/shared/admin'
import { createTranslator } from 'use-intl'
import {
  actionLook,
  actMessage,
  bulkOffer,
  bulkTargets,
  confirmWords,
  historyWords,
  promptFor,
  type Translate,
  undoMessage,
} from '../src/admin/act'
import { describeLibrary, restoreDone } from '../src/admin/areas/sites'
import { ADMIN_MESSAGES } from '../src/admin/i18n'
import { healthSummary } from '../src/admin/overview'
import { OVERVIEW } from './admin-fixtures'

const translator = (locale: 'en' | 'zh-Hans'): Translate =>
  createTranslator({
    locale,
    messages: { admin: ADMIN_MESSAGES[locale] },
    namespace: 'admin.shell',
  }) as unknown as Translate

const t = translator('en')
const titles: Record<string, string> = { '7': 'Pfadwerk', '12': 'Nordvest' }
const titleOf = (id: string) => titles[id] ?? null

describe('the words', () => {
  // use-intl reads a dot in a key as nesting, so `actions.site.feature.label` must be nested in the
  // catalogue: a key written "site.feature" would never be found, in any language.
  test.each(['en', 'zh-Hans'] as const)(
    '%s has every action’s label, short form and past tense',
    (lang) => {
      const words = translator(lang)
      for (const action of ADMIN_ACTIONS) {
        for (const form of ['label', 'short', 'done']) {
          const key = `actions.${action}.${form}`
          expect({ key, text: words(key) }).not.toEqual({ key, text: `admin.shell.${key}` })
        }
      }
      for (const action of ACTION_CONFIRM) {
        expect(words(`confirm.${action}`)).not.toBe(`admin.shell.confirm.${action}`)
        expect(words(`confirmMany.${action}`, { n: 3 })).not.toBe(
          `admin.shell.confirmMany.${action}`,
        )
      }
    },
  )
})

describe('asking first', () => {
  test('an action that needs words asks for them, unless they were given', () => {
    expect(promptFor('claim.reject')).toEqual({ input: 'reason' })
    expect(promptFor('code.addUses')).toEqual({ input: 'uses' })
    expect(promptFor('code.create')).toEqual({ input: 'code' })
    expect(promptFor('invite.address')).toEqual({ input: 'email' })
    expect(promptFor('claim.reject', { reason: 'Not the author' })).toBeNull()
  })

  test('an action hard to take back asks for a yes, even with its words given', () => {
    expect(promptFor('claim.vouch')).toEqual({ confirm: true })
    expect(promptFor('claim.remove')).toEqual({ confirm: true })
    expect(promptFor('member.signOut')).toEqual({ confirm: true })
    expect(promptFor('code.revoke', {})).toEqual({ confirm: true })
    expect(promptFor('hold.cancel')).toEqual({ confirm: true })
  })

  test('the rest go at once', () => {
    expect(promptFor('site.feature')).toBeNull()
    expect(promptFor('feed.pause')).toBeNull()
    expect(promptFor('site.topics', { topics: ['essays'] })).toBeNull()
  })
})

describe('a confirmation', () => {
  test('asks of one target in the singular, of several by their number', () => {
    expect(confirmWords(t, { action: 'code.revoke', ids: ['code:A'] })).toBe(
      'Revoke this code? Nobody else can join with it; whoever joined keeps their account.',
    )
    expect(confirmWords(t, { action: 'code.revoke', ids: ['code:A', 'code:B', 'code:C'] })).toBe(
      'Revoke these 3 codes? Nobody else can join with them; whoever joined keeps their account.',
    )
    expect(
      confirmWords(translator('zh-Hans'), { action: 'hold.cancel', ids: ['hold:1', 'hold:2'] }),
    ).toBe('确定取消这 2 份邀请吗？这些邮箱将无法再用它们完成加入。')
  })
})

describe('the bulk bar', () => {
  const code = (id: string): AdminRowBase => ({ id, actions: ['code.revoke', 'code.addUses'] })
  const revoked = (id: string): AdminRowBase => ({ id, actions: ['code.restore'] })
  const hold = (id: string): AdminRowBase => ({ id, actions: ['hold.cancel'] })
  const bulk = ['code.revoke', 'hold.cancel'] as const

  test('offers an action only while a checked row takes it', () => {
    expect(bulkOffer(bulk, [code('code:A'), code('code:B')])).toEqual(['code.revoke'])
    expect(bulkOffer(bulk, [hold('hold:1')])).toEqual(['hold.cancel'])
    expect(bulkOffer(bulk, [code('code:A'), hold('hold:1')])).toEqual([
      'code.revoke',
      'hold.cancel',
    ])
    expect(bulkOffer(bulk, [revoked('code:C')])).toEqual([])
    expect(bulkOffer([], [code('code:A')])).toEqual([])
  })

  test('sends an action for the rows it applies to, never the rest', () => {
    const checked = [code('code:A'), hold('hold:1'), revoked('code:C'), code('code:B')]
    expect(bulkTargets('code.revoke', checked)).toEqual(['code:A', 'code:B'])
    expect(bulkTargets('hold.cancel', checked)).toEqual(['hold:1'])
  })
})

describe('how an action looks', () => {
  test('a taking-away action is danger wherever it is', () => {
    for (const action of [
      'site.hide',
      'claim.reject',
      'claim.remove',
      'code.revoke',
      'hold.cancel',
    ] as const) {
      expect(actionLook(action, 0)).toBe('danger')
      expect(actionLook(action, 2)).toBe('danger')
    }
  })

  test('the likeliest is filled, the others quiet', () => {
    expect(actionLook('site.feature', 0)).toBe('primary')
    expect(actionLook('site.feature', 1)).toBe('ghost')
    expect(actionLook('member.signOut', 0)).toBe('primary')
  })
})

describe('the toast', () => {
  test('one row: what was done, to what', () => {
    const response = { done: ['12'], failed: [], undo: { group: 'g1' } }
    expect(actMessage(t, { action: 'site.feature', response, titleOf })).toBe('Featured · Nordvest')
  })

  test('an area’s own words for what it did, where it named the action its own way', () => {
    const response = { done: ['12'], failed: [], undo: { group: 'g4' } }
    expect(actMessage(t, { action: 'site.restore', response, titleOf, words: 'Unfeatured' })).toBe(
      'Unfeatured · Nordvest',
    )
    expect(actMessage(t, { action: 'site.restore', response, titleOf })).toBe('Restored · Nordvest')
  })

  test('Restore says what it did to the blog, as its button said it', () => {
    const library = (locale: 'en' | 'zh-Hans') =>
      createTranslator({
        locale,
        messages: { admin: ADMIN_MESSAGES[locale] },
        namespace: 'admin.library',
      }) as unknown as Parameters<typeof restoreDone>[0]
    expect(restoreDone(library('en'), 'featured', 'site.restore')).toBe('Unfeatured')
    expect(restoreDone(library('en'), 'rejected', 'site.restore')).toBe('Restored to default')
    expect(restoreDone(library('zh-Hans'), 'featured', 'site.restore')).toBe('已取消精选')
    // Any other action, or a listing Restore does not change, keeps the shell's words.
    expect(restoreDone(library('en'), 'featured', 'site.hide')).toBeUndefined()
    expect(restoreDone(library('en'), 'listed', 'site.restore')).toBeUndefined()
  })

  test('a row the ledger did not show: the action alone', () => {
    const response = { done: ['99'], failed: [], undo: null }
    expect(actMessage(t, { action: 'feed.fetch', response, titleOf })).toBe('Fetch queued')
  })

  test('several rows: how many', () => {
    const response = { done: ['7', '12'], failed: [], undo: { group: 'g2' } }
    expect(actMessage(t, { action: 'site.hide', response, titleOf })).toBe('Hidden · 2 items')
    expect(actMessage(translator('zh-Hans'), { action: 'site.hide', response, titleOf })).toBe(
      '已隐藏 · 2 项',
    )
  })

  test('some did, some did not: both counts and the first reason', () => {
    const response = {
      done: ['7'],
      failed: [{ id: '12', error: 'not_applicable' as const }],
      undo: { group: 'g3' },
    }
    expect(actMessage(t, { action: 'site.feature', response, titleOf })).toBe(
      'Featured · 1 done, 1 not: Nothing to change',
    )
  })

  test('none did: the reason alone', () => {
    const response = { done: [], failed: [{ id: '88', error: 'no_relay' as const }], undo: null }
    expect(actMessage(t, { action: 'feed.relay', response, titleOf })).toBe(
      'No China relay is configured',
    )
    // A code this build does not know reads as a failure, not as a missing message.
    const odd = { done: [], failed: [{ id: '1', error: 'weird' as never }], undo: null }
    expect(actMessage(t, { action: 'feed.relay', response: odd, titleOf })).toBe(
      "Couldn't reach Tela. Try again.",
    )
  })

  test('no answer at all', () => {
    expect(actMessage(t, { action: 'site.list', response: null, titleOf })).toBe(
      "Couldn't reach Tela. Try again.",
    )
  })

  test('an undo: done, too late, or gone', () => {
    expect(undoMessage(t, { restored: 2 })).toBe('Undone')
    expect(undoMessage(t, { error: 'changed_since' })).toBe(
      'Something changed since, so nothing was undone',
    )
    expect(undoMessage(t, { error: 'not_found' })).toBe('It no longer exists')
    expect(undoMessage(t, null)).toBe("Couldn't reach Tela. Try again.")
  })
})

describe('what an audit entry says', () => {
  test('an action in its past tense, an undo of one, a grant', () => {
    expect(historyWords(t, { action: 'feed.pause' })).toBe('Paused')
    expect(historyWords(t, { action: 'undo', undid: 'feed.pause' })).toBe('Undid: Paused')
    expect(historyWords(translator('zh-Hans'), { action: 'undo', undid: 'site.hide' })).toBe(
      '撤销：已隐藏',
    )
    expect(historyWords(t, { action: 'undo' })).toBe('Undone')
    expect(historyWords(t, { action: 'admin.grant' })).toBe('Made an admin')
    expect(historyWords(t, { action: 'admin.ungrant' })).toBe('No longer an admin')
    expect(historyWords(t, { action: 'site.retire' as never })).toBe('site.retire')
  })
})

describe('what a library record’s History says', () => {
  const both = (locale: 'en' | 'zh-Hans') =>
    [
      createTranslator({
        locale,
        messages: { admin: ADMIN_MESSAGES[locale] },
        namespace: 'admin.library',
      }) as unknown as Parameters<typeof describeLibrary>[0],
      translator(locale) as unknown as Parameters<typeof describeLibrary>[1],
    ] as const

  test('the topics a blog was given, and a rejection’s reason, in each language’s punctuation', () => {
    const [library, shell] = both('en')
    expect(describeLibrary(library, shell, { action: 'site.topics', to: ['tech', 'essays'] })).toBe(
      'Topics saved: Tech, Essays',
    )
    expect(describeLibrary(library, shell, { action: 'site.topics', to: [] })).toBe(
      'Topics saved: —',
    )
    expect(
      describeLibrary(library, shell, { action: 'claim.reject', to: { error: 'Not the author' } }),
    ).toBe('Rejected: “Not the author”')
    const [zh, zhShell] = both('zh-Hans')
    expect(describeLibrary(zh, zhShell, { action: 'site.topics', to: ['tech', 'essays'] })).toBe(
      '话题已保存：技术、随笔',
    )
    expect(
      describeLibrary(zh, zhShell, { action: 'claim.reject', to: { error: '不是作者' } }),
    ).toBe('已驳回：“不是作者”')
  })

  test('a Restore in its button’s words', () => {
    const [library, shell] = both('en')
    const restore = (listing: string) =>
      describeLibrary(library, shell, { action: 'site.restore', from: { listing } })
    expect(restore('featured')).toBe('Unfeatured')
    expect(restore('rejected')).toBe('Restored to default')
    // Anything else reads as the action's own past tense.
    expect(describeLibrary(library, shell, { action: 'site.hide' })).toBeUndefined()
  })
})

describe('the health line', () => {
  test('what fails, then that the rest is fine', () => {
    expect(healthSummary(t, OVERVIEW.health, 'en')).toBe(
      '24 articles have waited over six hours for the full text, above the limit of 20. Everything else is within limits.',
    )
    expect(healthSummary(translator('zh-Hans'), OVERVIEW.health, 'zh-Hans')).toBe(
      '24 篇文章等待全文已超过六小时，超过上限 20。其余都在正常范围内。',
    )
  })

  test('everything fine', () => {
    const fine: AdminHealth = {
      ...OVERVIEW.health,
      ok: true,
      checks: OVERVIEW.health.checks.map((check) => ({ ...check, ok: true })),
    }
    expect(healthSummary(t, fine, 'en')).toBe('Everything is within limits.')
  })

  test('everything failing has no “else”', () => {
    const bad: AdminHealth = {
      ok: false,
      at: 0,
      checks: [
        { name: 'overdueFeeds', value: 1, limit: 3, ok: false },
        { name: 'backupVerified', value: null, limit: null, ok: false },
      ],
    }
    expect(healthSummary(t, bad, 'en')).toBe(
      '1 feed is more than two hours past due, above the limit of 3. The last backup failed its check.',
    )
  })
})
