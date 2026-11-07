/**
 * Financial hold — chặn settlement của seller, không xoá earnings.
 *
 * ADR-0007 phân biệt hai scope:
 *
 * - `settlement`: chặn đúng kỳ (`period`) của seller tenant.
 * - `account`: chặn mọi kỳ của seller tenant (fraud/compliance).
 *
 * Hold **không** phải restriction: nó không đổi balance, không xoá earnings,
 * không chặn seller đăng nhập hay publish. Nó chỉ là điều kiện được kiểm trong
 * `settlePayable`. Vì vậy mọi function ở đây là append/transition trên danh sách
 * hold, không post bút toán.
 *
 * Hold luôn cần `reason_ref` và `actor_ref` — một hold không giải thích được
 * không phải một hold, mà là một lỗi vận hành bị che.
 */

import type { FinancialBook } from './book';
import { isFinancialHold, type FinancialHold, type HoldScope } from './records';
import {
  financialFailure,
  financialOk,
  freezeArray,
  isEpochMillis,
  isOpaqueId,
  type ActorRef,
  type FinancialResult,
  type TenantRef,
} from './shared';

/** Input của `openHold`. */
export interface OpenHoldInput {
  readonly holdId: string;
  readonly scope: HoldScope;
  readonly sellerTenant: string;
  /** Bắt buộc khi `scope === 'settlement'`; phải `null` khi `scope === 'account'`. */
  readonly period: string | null;
  readonly reasonRef: string;
  readonly actorRef: string;
  readonly startedAt: number;
}

/** Kết quả của một operation hold. */
export interface HoldOutcome {
  readonly book: FinancialBook;
  readonly hold: FinancialHold;
  readonly replayed: boolean;
}

/** Tìm hold theo id. */
export function findHold(book: FinancialBook, holdId: string): FinancialResult<FinancialHold> {
  const hold = book.holds.find((candidate) => candidate.hold_id === holdId);
  return hold === undefined ? financialFailure('hold_not_found') : financialOk(hold);
}

/** Thay một hold trong book. */
function replaceHold(book: FinancialBook, hold: FinancialHold): FinancialBook {
  return Object.freeze({
    ...book,
    holds: freezeArray(
      book.holds.map((candidate) => (candidate.hold_id === hold.hold_id ? hold : candidate)),
    ),
  });
}

/**
 * Mở một hold mới.
 *
 * Scope `settlement` đòi `period`; scope `account` đòi `period === null`. Một
 * account hold mang period sẽ khiến người đọc hiểu sai phạm vi, nên bị từ chối
 * thay vì được chuẩn hoá ngầm.
 */
export function openHold(book: FinancialBook, input: OpenHoldInput): FinancialResult<HoldOutcome> {
  if (
    !isOpaqueId(input.holdId) ||
    !isOpaqueId(input.sellerTenant) ||
    !isOpaqueId(input.reasonRef) ||
    !isOpaqueId(input.actorRef) ||
    !isEpochMillis(input.startedAt) ||
    (input.scope !== 'settlement' && input.scope !== 'account')
  ) {
    return financialFailure('invalid_hold');
  }
  if (input.scope === 'settlement') {
    if (!isOpaqueId(input.period)) {
      return financialFailure('invalid_hold');
    }
  } else if (input.period !== null) {
    return financialFailure('invalid_hold');
  }
  const existing = book.holds.find((candidate) => candidate.hold_id === input.holdId);
  if (existing !== undefined) {
    if (
      existing.scope !== input.scope ||
      existing.seller_tenant !== input.sellerTenant ||
      existing.period !== input.period
    ) {
      return financialFailure('idempotency_conflict');
    }
    return financialOk(Object.freeze({ book, hold: existing, replayed: true }));
  }
  const hold: FinancialHold = Object.freeze({
    hold_id: input.holdId,
    scope: input.scope,
    seller_tenant: input.sellerTenant as TenantRef,
    period: input.period,
    reason_ref: input.reasonRef,
    actor_ref: input.actorRef as ActorRef,
    started_at: input.startedAt,
    released_at: null,
    released_by: null,
  });
  if (!isFinancialHold(hold)) {
    return financialFailure('invalid_hold');
  }
  return financialOk(
    Object.freeze({
      book: Object.freeze({ ...book, holds: freezeArray([...book.holds, hold]) }),
      hold,
      replayed: false,
    }),
  );
}

/** Input của `releaseHold`. */
export interface ReleaseHoldInput {
  readonly holdId: string;
  readonly releasedAt: number;
  readonly actorRef: string;
}

/**
 * Release một hold.
 *
 * Release trước `started_at` bị từ chối — một hold kết thúc trước khi bắt đầu là
 * dấu hiệu input sai, không phải một hold vô hại. Release lặp lại là idempotent.
 */
export function releaseHold(
  book: FinancialBook,
  input: ReleaseHoldInput,
): FinancialResult<HoldOutcome> {
  const found = findHold(book, input.holdId);
  if (!found.ok) {
    return found;
  }
  const hold = found.value;
  if (hold.released_at !== null) {
    return financialOk(Object.freeze({ book, hold, replayed: true }));
  }
  if (!isEpochMillis(input.releasedAt) || !isOpaqueId(input.actorRef)) {
    return financialFailure('invalid_hold');
  }
  if (input.releasedAt < hold.started_at) {
    return financialFailure('invalid_hold');
  }
  const next: FinancialHold = Object.freeze({
    ...hold,
    // `actor_ref` giữ nguyên người mở hold; người release ghi vào `released_by`
    // để audit truy được cả hai đầu thay vì ghi đè một trong hai.
    released_by: input.actorRef as ActorRef,
    released_at: input.releasedAt,
  });
  return financialOk(Object.freeze({ book: replaceHold(book, next), hold: next, replayed: false }));
}

/** Danh sách hold đang hiệu lực của một seller tenant tại thời điểm `at`. */
export function activeHolds(
  book: FinancialBook,
  sellerTenant: TenantRef,
  at: number,
): readonly FinancialHold[] {
  return book.holds.filter(
    (hold) =>
      hold.seller_tenant === sellerTenant &&
      // Hold chưa bắt đầu thì chưa chặn gì: một `started_at` ở tương lai không
      // được biến thành restriction hiện tại.
      hold.started_at <= at &&
      (hold.released_at === null || hold.released_at > at),
  );
}
