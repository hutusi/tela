/**
 * What an operator can change while Tela runs (ADR 0056): the sign-up mode, the limits on an
 * ordinary account, the day's translation budgets and when to be told. Defaults live here; a row
 * in `settings` overrides one, and the admin console or `bun run admin set` writes it, audited.
 *
 * A limit is a number or `null`, and `null` means no limit. `0` means none at all: a budget of 0
 * pauses what it budgets, never unlimits it, so an operator reaching for "stop" gets stop.
 */

export const SIGNUP_MODES = ['open', 'invite'] as const
export type SignupMode = (typeof SIGNUP_MODES)[number]

/** Whether approved apps may act at all (ADR 0064): off answers every API call 503. */
export const APPS_SWITCH = ['on', 'off'] as const
export type AppsSwitch = (typeof APPS_SWITCH)[number]

type ChoiceSetting<T extends string> = {
  kind: 'choice'
  choices: readonly T[]
  default: T
}
type LimitSetting = { kind: 'limit'; default: number | null; max: number }
type PercentsSetting = { kind: 'percents'; default: readonly number[] }

export const SETTINGS = {
  /** `invite`: an account needs an invitation (ADR 0034). `open`: a proved address is enough. */
  'signup.mode': { kind: 'choice', choices: SIGNUP_MODES, default: 'invite' },
  /** New accounts per UTC day; past it, joining waits for the next day. */
  'signup.maxPerDay': { kind: 'limit', default: 200, max: 1_000_000 },
  /** New accounts in a day that mail the operator. */
  'alerts.signupsPerDay': { kind: 'limit', default: 50, max: 1_000_000 },
  /**
   * Body translations a member's requests pay for per UTC day: one already made for anyone, a
   * conversion between the Chinese scripts, or one that cost nothing does not count.
   */
  'member.translationsPerDay': { kind: 'limit', default: 20, max: 100_000 },
  /** Feeds new to Tela a member adds per UTC day; subscribing to one Tela has is free. */
  'member.feedsPerDay': { kind: 'limit', default: 20, max: 100_000 },
  /** Subscriptions one account holds. */
  'member.maxSubscriptions': { kind: 'limit', default: 300, max: 1_000_000 },
  /**
   * Posts a member opens in full per UTC day from blogs they do not subscribe to, on the web and
   * in every app together (ADR 0066). Their own blogs are never counted.
   */
  'member.unsubscribedPostsPerDay': { kind: 'limit', default: 100, max: 1_000_000 },
  /** Whether approved apps may act for members (ADR 0064): `off` stops every app at once. */
  'apps.enabled': { kind: 'choice', choices: APPS_SWITCH, default: 'on' },
  /** Model tokens per UTC day, titles and bodies, everyone's together. */
  'translation.siteDailyTokens': { kind: 'limit', default: 10_000_000, max: 10_000_000_000 },
  /**
   * Model tokens per UTC day for background work (titles). `null` reads tela-jobs'
   * `LLM_DAILY_BUDGET_TOKENS`, where 0 means no limit, as it always has.
   */
  'translation.backgroundDailyTokens': { kind: 'limit', default: null, max: 10_000_000_000 },
  /** Shares of the site budget, in percent, at which the operator is mailed once a day. */
  'alerts.budgetPercents': { kind: 'percents', default: [80, 100] },
} as const satisfies Record<string, ChoiceSetting<string> | LimitSetting | PercentsSetting>

export type SettingKey = keyof typeof SETTINGS
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[]

export type SettingValue<K extends SettingKey> =
  (typeof SETTINGS)[K] extends ChoiceSetting<infer T>
    ? T
    : (typeof SETTINGS)[K] extends PercentsSetting
      ? number[]
      : number | null

export type Settings = { [K in SettingKey]: SettingValue<K> }

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === 'string' && Object.hasOwn(SETTINGS, value)
}

export function settingDefault<K extends SettingKey>(key: K): SettingValue<K> {
  const value = SETTINGS[key].default as unknown
  return (Array.isArray(value) ? [...value] : value) as SettingValue<K>
}

/** Every default, as one object. */
export function defaultSettings(): Settings {
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, settingDefault(k)])) as unknown as Settings
}

/** A value for `key`, or why it is not one. The one check the API, the CLI and the console share. */
export function parseSetting<K extends SettingKey>(
  key: K,
  value: unknown,
): { ok: true; value: SettingValue<K> } | { ok: false; error: string } {
  const spec = SETTINGS[key] as ChoiceSetting<string> | LimitSetting | PercentsSetting
  if (spec.kind === 'choice') {
    return typeof value === 'string' && spec.choices.includes(value)
      ? { ok: true, value: value as SettingValue<K> }
      : { ok: false, error: `one of ${spec.choices.join(', ')}` }
  }
  if (spec.kind === 'limit') {
    if (value === null) return { ok: true, value: null as SettingValue<K> }
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= spec.max
      ? { ok: true, value: value as SettingValue<K> }
      : { ok: false, error: `a whole number from 0 to ${spec.max}, or null for no limit` }
  }
  const ok =
    Array.isArray(value) &&
    value.length <= 10 &&
    value.every((p) => typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 100)
  return ok
    ? { ok: true, value: [...new Set(value as number[])].sort((a, b) => a - b) as SettingValue<K> }
    : { ok: false, error: 'a list of whole percentages from 1 to 100' }
}

/**
 * A value typed by an operator (`bun run admin set member.feedsPerDay 30`): JSON when it reads as
 * JSON, else the bare word, so `open` needs no quotes.
 */
export function parseSettingText<K extends SettingKey>(key: K, text: string) {
  let value: unknown = text.trim()
  try {
    value = JSON.parse(text)
  } catch {}
  return parseSetting(key, value)
}

/** Whether `used` has reached a limit: `null` never does, `0` always has. */
export function reached(limit: number | null, used: number): boolean {
  return limit !== null && used >= limit
}
