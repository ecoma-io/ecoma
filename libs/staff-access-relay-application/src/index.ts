/**
 * Barrel exports cho `@ecoma-io/staff-access-relay-application`.
 *
 * Use-case orchestration thuần thuật toán: mọi I/O đi qua port
 * ({@link OutboxRepository}, {@link QueuePublisher}), mọi ngưỡng vận hành là
 * tham số của {@link RelayCycleDeps}. Không type nào ở đây rò rỉ binding của
 * Cloudflare hay type của driver `pg` — ranh giới mà `pnpm dx arch-check` và
 * spec trong lib này cùng giữ.
 */

export type { OutboxRow } from './records';

export type {
  ClaimPendingInput,
  MarkPublishedInput,
  MarkSettledInput,
  OutboxRepository,
  RecordFailureInput,
} from './outbox-repository';

export type { QueuePublisher } from './queue-publisher';

export {
  backoffDelayMs,
  RELAY_EVENT_DEADLINES_MS,
  type EventClassForRow,
  type RelayEventClass,
  type RelayCycleDeps,
  type RelayCycleResult,
  runRelayCycle,
} from './run-relay-cycle';
