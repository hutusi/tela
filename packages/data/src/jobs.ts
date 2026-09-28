/**
 * What travels on the queues, shared by everything that sends work (tela-jobs' tick, tela-api for
 * work a reader triggers) and the consumer. A message is only an accelerator: it carries exactly
 * enough to fence the work to its claim, and a lost one costs nothing (ADR 0021).
 */
import type { LeaseKind } from './schema/values'

export const QUEUES = ['fetch', 'extract', 'translate', 'misc'] as const
export type QueueName = (typeof QUEUES)[number]

export type JobMessage = { kind: LeaseKind; key: string; owner: string }
export type JobQueues = { [Q in QueueName]: JobMessage }
