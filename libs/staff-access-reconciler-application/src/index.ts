/**
 * Barrel exports cho `@ecoma-io/staff-access-reconciler-application`.
 *
 * Use-case reconciliation thuần thuật toán: I/O duy nhất là đọc outbox qua port
 * {@link OutboxReconcileRepository}; mọi ngưỡng vận hành là tham số của
 * {@link ReconciliationCycleDeps}. Alert-only — không có operation ghi nào ở
 * đây, nên không có port ghi nào được expose.
 */

export type {
  ListStalePublishedInput,
  OutboxReconcileRepository,
  StalePublishedEvent,
} from './outbox-reconcile-repository';

export {
  MAX_RECONCILIATION_LIMIT,
  runReconciliationCycle,
  type ReconciliationCycleDeps,
  type ReconciliationCycleResult,
} from './run-reconciliation-cycle';
