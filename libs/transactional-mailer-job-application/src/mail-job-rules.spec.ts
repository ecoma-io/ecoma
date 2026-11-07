import { describe, expect, it } from 'vitest';

import type { MailJobRecord } from './mail-job-model';
import {
  canPersistExecutionResultFor,
  classifyBudgetExhaustedDenial,
  classifyGenerationAdvanceDenial,
  classifyLeaseOwnershipDenial,
  classifyReportCompletionDenial,
  classifyReportLeaseDenial,
  classifySameGenerationClaimDenial,
  dispositionForControlPlaneOutcome,
  isEligibleForBlockedBacklogSweep,
  isEligibleForReportSweep,
  isEligibleForStaleLeaseSweep,
  isExecutionLeaseActive,
  isMailJobStatus,
  isOutcomeReportState,
  isReportLeaseActive,
  isTerminalStatus,
  isWithinProviderSafeWindow,
  classifyProviderCallBoundaryDenial,
} from './mail-job-rules';

/** Mốc thời gian dùng chung — mọi biên được tính trên giá trị tường minh, không dùng đồng hồ. */
const NOW = 1_800_000_000_000;

/**
 * Row `processing` hợp lệ, không lease, generation 1, chưa tiêu ngân sách B — nền cho
 * mọi ca test dưới đây chỉ thay đúng field mà ca đó đang kiểm.
 */
function processingRow(overrides: Partial<MailJobRecord> = {}): MailJobRecord {
  return {
    deliveryId: 'delivery-1',
    messageId: 'message-1',
    dispatchGeneration: 1,
    executionGeneration: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    status: 'processing',
    attempts: 0,
    lastError: null,
    lastErrorClass: null,
    providerMessageId: null,
    outcomeReportState: 'none',
    reportLeaseOwner: null,
    reportLeaseExpiresAt: null,
    reportAttempts: 0,
    blockedAt: null,
    providerCallAt: null,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

describe('lease activity boundaries', () => {
  it('treats an execution lease as active only strictly after its expiry', () => {
    const held = processingRow({ leaseOwner: 'owner-a', leaseExpiresAt: NOW + 1 });

    expect(isExecutionLeaseActive(held, NOW)).toBe(true);
    // Biên: đúng tại `lease_expires_at = now` phải là "hết hiệu lực" — trùng guard
    // `lease_expires_at <= :now` của statement (a)/(c); lệch một dấu ở đây là hai
    // execution cùng coi mình giữ lease.
    expect(isExecutionLeaseActive(held, NOW + 1)).toBe(false);
    expect(isExecutionLeaseActive(held, NOW + 2)).toBe(false);
  });

  it('treats a missing owner or expiry as no lease at all', () => {
    expect(isExecutionLeaseActive({ leaseOwner: null, leaseExpiresAt: null }, NOW)).toBe(false);
    // Cột lệch đôi (vi phạm parity) không được coi là lease hiệu lực thay vì fail-open.
    expect(isExecutionLeaseActive({ leaseOwner: 'owner-a', leaseExpiresAt: null }, NOW)).toBe(
      false,
    );
    expect(isExecutionLeaseActive({ leaseOwner: null, leaseExpiresAt: NOW + 1 }, NOW)).toBe(false);
  });

  it('applies the same boundary rules to the report lease', () => {
    const held = { reportLeaseOwner: 'sweeper-1', reportLeaseExpiresAt: NOW + 1 };

    expect(isReportLeaseActive(held, NOW)).toBe(true);
    expect(isReportLeaseActive(held, NOW + 1)).toBe(false);
    expect(isReportLeaseActive({ reportLeaseOwner: null, reportLeaseExpiresAt: null }, NOW)).toBe(
      false,
    );
    expect(
      isReportLeaseActive({ reportLeaseOwner: 'sweeper-1', reportLeaseExpiresAt: null }, NOW),
    ).toBe(false);
  });
});

describe('isTerminalStatus', () => {
  it('marks sent and failed as terminal but keeps blocked claimable by generation advance', () => {
    expect(isTerminalStatus('sent')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    // `blocked` không phải terminal theo execution: chỉ redrive có authorize mới mở
    // khoá (đường (b) không loại `blocked` trong WHERE của nó).
    expect(isTerminalStatus('blocked')).toBe(false);
    expect(isTerminalStatus('processing')).toBe(false);
  });
});

describe('classifySameGenerationClaimDenial', () => {
  const criteria = {
    deliveryId: 'delivery-1',
    dispatchGeneration: 1,
    nowMs: NOW,
    maxExecutionAttempts: 3,
  };

  it('reports missing-job when the row does not exist', () => {
    expect(classifySameGenerationClaimDenial(null, criteria)).toBe('missing-job');
  });

  it('reports generation-mismatch before any other reason', () => {
    // Row đã sang generation 2: không bao giờ được claim bằng generation cũ, dù
    // lease cũng đang hoạt động — hai lý do cùng xuất hiện, generation thắng.
    const record = processingRow({
      dispatchGeneration: 2,
      leaseOwner: 'owner-a',
      leaseExpiresAt: NOW + 10_000,
    });

    expect(classifySameGenerationClaimDenial(record, criteria)).toBe('generation-mismatch');
  });

  it('reports lease-active ahead of an exhausted budget', () => {
    // Thứ tự ưu tiên: một execution đang sống phải che lý do ngân sách, vì statement
    // (c) KHÔNG được cắt ngang execution đang chạy (§9.2.1 (c)).
    const record = processingRow({
      attempts: 3,
      leaseOwner: 'owner-a',
      leaseExpiresAt: NOW + 10_000,
    });

    expect(classifySameGenerationClaimDenial(record, criteria)).toBe('lease-active');
  });

  it('reports budget-exhausted when no lease is held and budget B is spent', () => {
    expect(classifySameGenerationClaimDenial(processingRow({ attempts: 3 }), criteria)).toBe(
      'budget-exhausted',
    );
  });

  it('reports budget-exhausted for a terminal row that also exhausted the budget', () => {
    // Ưu tiên có chủ đích: caller thử đường (c), đường đó trả `terminal` nhờ guard
    // `status NOT IN (...)`, và caller ack. Kết quả cuối vẫn là hành vi đúng.
    const record = processingRow({ status: 'sent', outcomeReportState: 'pending', attempts: 3 });

    expect(classifySameGenerationClaimDenial(record, criteria)).toBe('budget-exhausted');
  });

  it('reports terminal for sent and failed rows with budget left', () => {
    expect(
      classifySameGenerationClaimDenial(
        processingRow({ status: 'sent', outcomeReportState: 'pending', attempts: 1 }),
        criteria,
      ),
    ).toBe('terminal');
    expect(
      classifySameGenerationClaimDenial(
        processingRow({ status: 'failed', outcomeReportState: 'pending', attempts: 1 }),
        criteria,
      ),
    ).toBe('terminal');
  });

  it('reports blocked for a row waiting on an authorized redrive', () => {
    const record = processingRow({
      status: 'blocked',
      blockedAt: NOW - 500,
      outcomeReportState: 'pending',
      attempts: 2,
    });

    expect(classifySameGenerationClaimDenial(record, criteria)).toBe('blocked');
  });

  it('reports budget-exhausted for a blocked row that also exhausted the budget', () => {
    // Cùng thứ tự ưu tiên như ca terminal ở trên: caller thử (c), (c) trả
    // `already-blocked` nhờ guard `status NOT IN (...)`, caller ack — hội tụ đúng.
    const record = processingRow({
      status: 'blocked',
      blockedAt: NOW - 500,
      outcomeReportState: 'pending',
      attempts: 3,
    });

    expect(classifySameGenerationClaimDenial(record, criteria)).toBe('budget-exhausted');
  });

  it('reports inconsistent instead of guessing when every guard looks satisfied', () => {
    expect(classifySameGenerationClaimDenial(processingRow({ attempts: 2 }), criteria)).toBe(
      'inconsistent',
    );
  });
});

describe('classifyGenerationAdvanceDenial', () => {
  const criteria = { deliveryId: 'delivery-1', newDispatchGeneration: 2, nowMs: NOW };

  it('reports missing-job when the row does not exist', () => {
    expect(classifyGenerationAdvanceDenial(null, criteria)).toBe('missing-job');
  });

  it('reports generation-not-newer when the authority is not strictly ahead of the row', () => {
    expect(
      classifyGenerationAdvanceDenial(processingRow({ dispatchGeneration: 2 }), criteria),
    ).toBe('generation-not-newer');
    expect(
      classifyGenerationAdvanceDenial(processingRow({ dispatchGeneration: 3 }), criteria),
    ).toBe('generation-not-newer');
  });

  it('reports lease-active when an older generation still holds a live lease', () => {
    const record = processingRow({ leaseOwner: 'owner-a', leaseExpiresAt: NOW + 10_000 });

    expect(classifyGenerationAdvanceDenial(record, criteria)).toBe('lease-active');
  });

  it('reports terminal for sent and failed rows', () => {
    expect(
      classifyGenerationAdvanceDenial(
        processingRow({ status: 'sent', outcomeReportState: 'pending' }),
        criteria,
      ),
    ).toBe('terminal');
    expect(
      classifyGenerationAdvanceDenial(
        processingRow({ status: 'failed', outcomeReportState: 'pending' }),
        criteria,
      ),
    ).toBe('terminal');
  });

  it('does not classify a blocked row as denied — every guard of (b) passes for it', () => {
    // `blocked` KHÔNG nằm trong `status NOT IN ('sent','failed')` của đường (b): chính
    // redrive ra khỏi `blocked` là lý do đường (b) tồn tại. Ở mức unit, guard passing
    // được biểu diễn bằng việc không có lý do phân loại nào; ca tích hợp kiểm statement thật.
    const blocked = processingRow({
      status: 'blocked',
      blockedAt: NOW - 500,
      outcomeReportState: 'pending',
    });
    const leaseInactive = !isExecutionLeaseActive(blocked, NOW);
    const notTerminal = !isTerminalStatus(blocked.status);
    const newer = blocked.dispatchGeneration < criteria.newDispatchGeneration;

    expect(leaseInactive && notTerminal && newer).toBe(true);
  });
});

describe('classifyBudgetExhaustedDenial', () => {
  const criteria = {
    deliveryId: 'delivery-1',
    dispatchGeneration: 1,
    nowMs: NOW,
    maxExecutionAttempts: 3,
  };

  it('reports missing-job when the row does not exist', () => {
    expect(classifyBudgetExhaustedDenial(null, criteria)).toBe('missing-job');
  });

  it('reports lease-active ahead of budget state so a live execution is never cut off', () => {
    const record = processingRow({
      attempts: 3,
      leaseOwner: 'owner-a',
      leaseExpiresAt: NOW + 10_000,
    });

    expect(classifyBudgetExhaustedDenial(record, criteria)).toBe('lease-active');
  });

  it('reports budget-not-exhausted when attempts remain', () => {
    expect(classifyBudgetExhaustedDenial(processingRow({ attempts: 2 }), criteria)).toBe(
      'budget-not-exhausted',
    );
  });

  it('reports terminal before already-blocked for a sent row at the bound', () => {
    // Một row `sent` không bao giờ được ghi `blocked` lần nữa: guard `status NOT IN`
    // của (c) loại nó, và phân loại phải dừng ở `terminal`.
    const record = processingRow({
      status: 'sent',
      outcomeReportState: 'pending',
      attempts: 3,
    });

    expect(classifyBudgetExhaustedDenial(record, criteria)).toBe('terminal');
  });

  it('reports already-blocked so a second application is recognized as idempotent', () => {
    const record = processingRow({
      status: 'blocked',
      blockedAt: NOW - 500,
      outcomeReportState: 'pending',
      attempts: 3,
    });

    expect(classifyBudgetExhaustedDenial(record, criteria)).toBe('already-blocked');
  });

  it('reports generation-mismatch when the row has already advanced', () => {
    expect(
      classifyBudgetExhaustedDenial(
        processingRow({ dispatchGeneration: 2, attempts: 3 }),
        criteria,
      ),
    ).toBe('generation-mismatch');
  });
});

describe('classifyLeaseOwnershipDenial', () => {
  it('distinguishes a deleted row from a lost claim', () => {
    // Hai nhánh cùng một hành động (không ghi, không báo, không gửi lại) nhưng thông
    // điệp vận hành khác nhau: `missing-job` là operator/repair, `lease-lost` là race.
    expect(classifyLeaseOwnershipDenial(null)).toBe('missing-job');
    expect(classifyLeaseOwnershipDenial(processingRow())).toBe('lease-lost');
    expect(classifyLeaseOwnershipDenial(processingRow({ status: 'sent' }))).toBe('lease-lost');
  });
});

describe('classifyProviderCallBoundaryDenial', () => {
  const expectation = {
    owner: 'owner-a',
    executionGeneration: 5,
    dispatchGeneration: 2,
  };

  /** Đang giữ lease chuẩn khớp `expectation`, chưa có marker — nền cho phân loại. */
  function claimedRow(overrides: Partial<MailJobRecord> = {}): MailJobRecord {
    return processingRow({
      leaseOwner: expectation.owner,
      leaseExpiresAt: NOW + 1,
      executionGeneration: expectation.executionGeneration,
      dispatchGeneration: expectation.dispatchGeneration,
      ...overrides,
    });
  }

  it('reports missing-job for an absent row before any ownership check', () => {
    expect(classifyProviderCallBoundaryDenial(null, expectation)).toBe('missing-job');
  });

  it('reports lease-lost before already-marked so a stale execution cannot reopen the window', () => {
    // EXECUTE trước (mất claim, marker cũ còn) rồi mới kiểm marker — bảo vệ chung:
    // một execution stale nhìn thấy marker của attempt trước phải classified là
    // `lease-lost` (KHÔNG được gọi provider), không phải `already-marked` ("nghe"
    // là được phép gọi).
    const staleButMarked = claimedRow({
      leaseOwner: 'owner-newer',
      executionGeneration: 6,
      providerCallAt: NOW - 10,
    });
    expect(classifyProviderCallBoundaryDenial(staleButMarked, expectation)).toBe('lease-lost');

    // Cả dispatchGeneration lệch cũng luôn `lease-lost` — cùng chiều fencing.
    const staleDispatch = claimedRow({ dispatchGeneration: 3 });
    expect(classifyProviderCallBoundaryDenial(staleDispatch, expectation)).toBe('lease-lost');
  });

  it('reports already-marked for a live execution replaying after a crash past the marker', () => {
    // Task #37/#38: `already-marked` là đường bình thường — caller của cùng attempt-chain
    // vẫn được gọi provider với cùng idempotency key. Marker tồn tại trước + claim còn giữ.
    const marked = claimedRow({ providerCallAt: NOW - 10 });
    expect(classifyProviderCallBoundaryDenial(marked, expectation)).toBe('already-marked');
  });

  it('reports inconsistent when nothing explains a zero-affected-rows update', () => {
    expect(classifyProviderCallBoundaryDenial(claimedRow(), expectation)).toBe('inconsistent');
  });
});

describe('isWithinProviderSafeWindow', () => {
  const boundaryMs = 24 * 60 * 60 * 1000;

  it('returns null when the marker has never been written', () => {
    // `null` là một phân loại riêng — kiểm nó trước cửa sổ an toàn, để caller không
    // tự động suy ra "chưa marker" với "trong cửa sổ".
    expect(
      isWithinProviderSafeWindow(processingRow({ providerCallAt: null }), {
        nowMs: NOW,
        providerCallSafeWindowMs: boundaryMs,
      }),
    ).toBeNull();
    expect(
      isWithinProviderSafeWindow(processingRow(), {
        nowMs: NOW,
        providerCallSafeWindowMs: boundaryMs,
      }),
    ).toBeNull();
  });

  it('treats the window as inclusive at the exact boundary', () => {
    const marked = processingRow({ providerCallAt: NOW - boundaryMs });
    // Biên inclusive: đúng tại `providerCallAt + window = now` là còn trong cửa sổ —
    // hợp với guard `<=` seçin của isExecutionLeaseActive (biên cuối của một phép tính
    // thời điểm).
    expect(
      isWithinProviderSafeWindow(marked, { nowMs: NOW, providerCallSafeWindowMs: boundaryMs }),
    ).toBe(true);
    expect(
      isWithinProviderSafeWindow(marked, { nowMs: NOW + 1, providerCallSafeWindowMs: boundaryMs }),
    ).toBe(false);
  });

  it('treats a marker written after now as inside the window (clock skew, not an error)', () => {
    // `providerCallAt > now` là lệch đồng hồ giữa các isolate, không phải trạng thái lỗi:
    // chênh dương vẫn rơi vào "chưa chắc ngoài cửa sổ" — fail-closed về phía auto-resend
    // trong cửa sổ, KHÔNG operator-blocked.
    const future = processingRow({ providerCallAt: NOW + 5 });
    expect(
      isWithinProviderSafeWindow(future, { nowMs: NOW, providerCallSafeWindowMs: boundaryMs }),
    ).toBe(true);
  });
});

/** Nền `sent` + report `pending` — trạng thái mà các statement report áp dụng. */
function pendingRow(overrides: Partial<MailJobRecord> = {}): MailJobRecord {
  return processingRow({
    status: 'sent',
    outcomeReportState: 'pending',
    ...overrides,
  });
}

describe('classifyReportLeaseDenial', () => {
  const criteria = { deliveryId: 'delivery-1', dispatchGeneration: 1, nowMs: NOW };

  it('reports missing-job when the row does not exist', () => {
    expect(classifyReportLeaseDenial(null, criteria)).toBe('missing-job');
  });

  it('reports generation-mismatch when the report belongs to an older generation', () => {
    expect(classifyReportLeaseDenial(pendingRow({ dispatchGeneration: 2 }), criteria)).toBe(
      'generation-mismatch',
    );
  });

  it('reports not-pending once reporting already finished or never started', () => {
    expect(
      classifyReportLeaseDenial(pendingRow({ outcomeReportState: 'reported' }), criteria),
    ).toBe('not-pending');
    expect(
      classifyReportLeaseDenial(
        processingRow({ status: 'blocked', blockedAt: NOW - 1, outcomeReportState: 'orphaned' }),
        criteria,
      ),
    ).toBe('not-pending');
    expect(classifyReportLeaseDenial(processingRow({ outcomeReportState: 'none' }), criteria)).toBe(
      'not-pending',
    );
  });

  it('reports report-lease-active when another reporter holds a live lease', () => {
    const record = pendingRow({
      reportLeaseOwner: 'sweeper-1',
      reportLeaseExpiresAt: NOW + 10_000,
    });

    expect(classifyReportLeaseDenial(record, criteria)).toBe('report-lease-active');
  });

  it('reports inconsistent when every guard of statement (d) looks satisfied', () => {
    expect(classifyReportLeaseDenial(pendingRow(), criteria)).toBe('inconsistent');
  });
});

/** Nền giữ report-lease của `sweeper-1` — trạng thái mà hoàn tất report áp dụng. */
function heldRow(overrides: Partial<MailJobRecord> = {}): MailJobRecord {
  return pendingRow({
    reportLeaseOwner: 'sweeper-1',
    reportLeaseExpiresAt: NOW + 10_000,
    ...overrides,
  });
}

describe('classifyReportCompletionDenial', () => {
  const criteria = {
    deliveryId: 'delivery-1',
    dispatchGeneration: 1,
    owner: 'sweeper-1',
    nowMs: NOW,
  };

  it('reports missing-job when the row does not exist', () => {
    expect(classifyReportCompletionDenial(null, criteria)).toBe('missing-job');
  });

  it('reports generation-mismatch when the row advanced past this generation', () => {
    expect(classifyReportCompletionDenial(heldRow({ dispatchGeneration: 2 }), criteria)).toBe(
      'generation-mismatch',
    );
  });

  it('reports not-pending when another reporter already finished', () => {
    expect(
      classifyReportCompletionDenial(heldRow({ outcomeReportState: 'reported' }), criteria),
    ).toBe('not-pending');
  });

  it('reports report-lease-lost when the lease moved to a different owner', () => {
    expect(
      classifyReportCompletionDenial(heldRow({ reportLeaseOwner: 'sweeper-2' }), criteria),
    ).toBe('report-lease-lost');
  });

  it('reports inconsistent when this owner still holds a live pending lease', () => {
    expect(classifyReportCompletionDenial(heldRow(), criteria)).toBe('inconsistent');
  });
});

describe('dispositionForControlPlaneOutcome', () => {
  it('maps applied and duplicate to reported', () => {
    expect(dispositionForControlPlaneOutcome('applied')).toEqual({ kind: 'reported' });
    expect(dispositionForControlPlaneOutcome('duplicate')).toEqual({ kind: 'reported' });
  });

  it('maps stale to superseded and not-found to orphaned', () => {
    // HTTP 200 với body `stale` vẫn KHÔNG phải success (§9.5).
    expect(dispositionForControlPlaneOutcome('stale')).toEqual({ kind: 'superseded' });
    expect(dispositionForControlPlaneOutcome('not-found')).toEqual({ kind: 'orphaned' });
  });

  it('keeps pending for contract, auth and transient failures without entering a retry loop', () => {
    expect(dispositionForControlPlaneOutcome('contract-rejected')).toEqual({
      kind: 'keep-pending',
    });
    expect(dispositionForControlPlaneOutcome('auth-rejected')).toEqual({ kind: 'keep-pending' });
    expect(dispositionForControlPlaneOutcome('transient')).toEqual({ kind: 'keep-pending' });
  });
});

describe('sweep eligibility predicates', () => {
  it('selects report rows by pending state, free lease and the persisted attempt bound', () => {
    const base = processingRow({
      status: 'sent',
      outcomeReportState: 'pending',
      reportAttempts: 2,
    });

    expect(isEligibleForReportSweep(base, { nowMs: NOW, maxReportAttempts: 3 })).toBe(true);
    // Bound là strict `<`: chạm đúng maxReportAttempts là hết quyền auto-retry.
    expect(isEligibleForReportSweep(base, { nowMs: NOW, maxReportAttempts: 2 })).toBe(false);
    // Report-lease còn hiệu lực → không quét (hai sweeper không báo trùng).
    expect(
      isEligibleForReportSweep(
        processingRow({
          status: 'sent',
          outcomeReportState: 'pending',
          reportAttempts: 0,
          reportLeaseOwner: 'sweeper-1',
          reportLeaseExpiresAt: NOW + 1,
        }),
        { nowMs: NOW, maxReportAttempts: 3 },
      ),
    ).toBe(false);
    // Hết hiệu lực đúng tại now → quét được, cùng biên với statement (d).
    expect(
      isEligibleForReportSweep(
        processingRow({
          status: 'sent',
          outcomeReportState: 'pending',
          reportAttempts: 0,
          reportLeaseOwner: 'sweeper-1',
          reportLeaseExpiresAt: NOW,
        }),
        { nowMs: NOW, maxReportAttempts: 3 },
      ),
    ).toBe(true);
    // Trạng thái khác `pending` không được đưa vào vòng báo lại.
    expect(isEligibleForReportSweep(processingRow(), { nowMs: NOW, maxReportAttempts: 3 })).toBe(
      false,
    );
  });

  it('selects stale-lease rows with the same expiry boundary as statement (a)', () => {
    const held = processingRow({ leaseOwner: 'owner-a', leaseExpiresAt: NOW });

    expect(isEligibleForStaleLeaseSweep(held, { nowMs: NOW })).toBe(true);
    expect(
      isEligibleForStaleLeaseSweep(
        processingRow({ leaseOwner: 'owner-a', leaseExpiresAt: NOW + 1 }),
        { nowMs: NOW },
      ),
    ).toBe(false);
    expect(isEligibleForStaleLeaseSweep(processingRow(), { nowMs: NOW })).toBe(false);
    // Row terminal không có lease (đã release khi persist) nên không xuất hiện ở sweep này.
    expect(
      isEligibleForStaleLeaseSweep(
        processingRow({ status: 'sent', outcomeReportState: 'pending' }),
        { nowMs: NOW },
      ),
    ).toBe(false);
  });

  it('selects blocked rows older than the backlog cutoff', () => {
    const blocked = processingRow({
      status: 'blocked',
      blockedAt: NOW - 10_000,
      outcomeReportState: 'pending',
    });

    expect(isEligibleForBlockedBacklogSweep(blocked, { cutoffMs: NOW })).toBe(true);
    expect(isEligibleForBlockedBacklogSweep(blocked, { cutoffMs: NOW - 10_000 })).toBe(true);
    expect(isEligibleForBlockedBacklogSweep(blocked, { cutoffMs: NOW - 10_001 })).toBe(false);
    expect(isEligibleForBlockedBacklogSweep(processingRow(), { cutoffMs: NOW })).toBe(false);
  });
});

describe('canPersistExecutionResultFor', () => {
  const expectation = {
    owner: 'owner-a',
    executionGeneration: 4,
    dispatchGeneration: 1,
    nowMs: NOW,
  };

  const ownedRow = processingRow({
    leaseOwner: 'owner-a',
    leaseExpiresAt: NOW + 10_000,
    executionGeneration: 4,
  });

  it('accepts the current owner of a live lease in matching generations', () => {
    expect(canPersistExecutionResultFor(ownedRow, expectation)).toBe(true);
    // Biên: lease còn hiệu lực đúng tại ranh giới (`> now`, không phải `>= now`).
    expect(
      canPersistExecutionResultFor(
        processingRow({
          leaseOwner: 'owner-a',
          leaseExpiresAt: NOW,
          executionGeneration: 4,
        }),
        expectation,
      ),
    ).toBe(false);
  });

  it('rejects a stale owner, a stale token and a stale generation', () => {
    expect(canPersistExecutionResultFor({ ...ownedRow, leaseOwner: 'owner-b' }, expectation)).toBe(
      false,
    );
    expect(canPersistExecutionResultFor({ ...ownedRow, executionGeneration: 3 }, expectation)).toBe(
      false,
    );
    expect(canPersistExecutionResultFor({ ...ownedRow, dispatchGeneration: 2 }, expectation)).toBe(
      false,
    );
  });

  it('rejects rows that are no longer in the executable report-free state', () => {
    expect(
      canPersistExecutionResultFor({ ...ownedRow, status: 'blocked', blockedAt: NOW }, expectation),
    ).toBe(false);
    expect(
      canPersistExecutionResultFor({ ...ownedRow, outcomeReportState: 'pending' }, expectation),
    ).toBe(false);
    expect(canPersistExecutionResultFor({ ...ownedRow, leaseExpiresAt: null }, expectation)).toBe(
      false,
    );
  });
});

describe('closed-set type guards', () => {
  it('accepts canonical values and rejects unknown persisted states', () => {
    expect(isMailJobStatus('processing')).toBe(true);
    expect(isMailJobStatus('retrying')).toBe(false);
    expect(isMailJobStatus(42)).toBe(false);
    expect(isOutcomeReportState('pending')).toBe(true);
    expect(isOutcomeReportState('lost')).toBe(false);
    expect(isOutcomeReportState(null)).toBe(false);
  });
});
