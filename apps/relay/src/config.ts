/** The relay's whole configuration: the secrets it accepts, where it listens, how long it waits. */
export type RelayConfig = { secrets: string[]; port: number; timeoutMs: number }

export function relayConfig(env: Record<string, string | undefined>): RelayConfig {
  const secret = env.RELAY_SECRET
  if (!secret || secret.length < 16) {
    throw new Error('RELAY_SECRET (at least 16 characters) is required')
  }
  const previous = env.RELAY_SECRET_PREVIOUS
  return {
    // The previous secret stays accepted while a new one rolls out to the fetching side.
    secrets: previous ? [secret, previous] : [secret],
    port: Number(env.RELAY_PORT ?? 8787),
    timeoutMs: Number(env.FETCH_TIMEOUT_MS ?? 20_000),
  }
}
