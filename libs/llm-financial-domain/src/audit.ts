/**
 * Financial audit — append-only log của mọi thay đổi tài chính.
 *
 * §3.11 của `01-architecture.md`: actor, action, target, amount, reference,
 * correlation ID, timestamp, fencing token. Không chứa secret/token — mọi tham
 * chiếu đều opaque.
 *
 * Module này cố tình **không** tự ghi audit từ các operation khác: ghi audit là
 * một quyết định của caller (nó biết correlation ID và actor), và lib không có
 * request context. Vì vậy ở đây chỉ có append + đọc; không có update/delete.
 */

import type { FinancialBook } from './book';
import { isFinancialAuditEntry, type AuditAction, type FinancialAuditEntry } from './records';
import { isMoney, type Money } from './money';
import {
  financialFailure,
  financialOk,
  freezeArray,
  isEpochMillis,
  isOpaqueId,
  type ActorRef,
  type FencingToken,
  type FinancialResult,
} from './shared';

/** Input của `appendAudit`. */
export interface AppendAuditInput {
  readonly action: AuditAction;
  readonly actorRef: string;
  readonly targetRef: string;
  readonly amount: Money | null;
  readonly correlationId: string;
  readonly at: number;
  readonly fencingToken: string;
}

/**
 * Thêm một dòng audit.
 *
 * Không idempotency key: audit là log, không phải mutation có thể replay — ghi
 * hai lần cùng một action với cùng correlation ID là hai sự kiện, và gộp chúng
 * sẽ che mất một lần gọi thật. Caller chịu trách nhiệm không ghi trùng.
 */
export function appendAudit(
  book: FinancialBook,
  input: AppendAuditInput,
): FinancialResult<FinancialBook> {
  if (
    !isOpaqueId(input.actorRef) ||
    !isOpaqueId(input.targetRef) ||
    !isOpaqueId(input.correlationId) ||
    !isOpaqueId(input.fencingToken) ||
    !isEpochMillis(input.at) ||
    (input.amount !== null && !isMoney(input.amount))
  ) {
    return financialFailure('invalid_id');
  }
  const entry: FinancialAuditEntry = Object.freeze({
    action: input.action,
    actor_ref: input.actorRef as ActorRef,
    target_ref: input.targetRef,
    amount: input.amount,
    correlation_id: input.correlationId,
    at: input.at,
    fencing_token: input.fencingToken as FencingToken,
  });
  if (!isFinancialAuditEntry(entry)) {
    return financialFailure('invalid_id');
  }
  return financialOk(Object.freeze({ ...book, audit: freezeArray([...book.audit, entry]) }));
}

/** Đọc audit log của book — trả bản readonly, không có cửa sửa. */
export function readAudit(book: FinancialBook): readonly FinancialAuditEntry[] {
  return book.audit;
}
