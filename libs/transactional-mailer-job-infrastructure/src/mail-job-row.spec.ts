import { describe, expect, it } from 'vitest';

import { MalformedMailJobStateError } from '@ecoma-io/transactional-mailer-job-application';

import {
  decodeMailJobRow,
  decodeQuarantineRow,
  MAIL_JOB_COLUMNS,
  QUARANTINE_COLUMNS,
} from './mail-job-row';

/** Hàng `mail_jobs` hợp lệ theo đúng 19 cột DDL, nền cho mọi ca âm bên dưới. */
function validRow(): Record<string, unknown> {
  return {
    delivery_id: 'delivery-1',
    message_id: 'message-1',
    dispatch_generation: 2,
    execution_generation: 5,
    lease_owner: 'owner-a',
    lease_expires_at: 1_800_000_010_000,
    status: 'processing',
    attempts: 3,
    last_error: 'http-429',
    last_error_class: 'retryable',
    provider_message_id: null,
    outcome_report_state: 'none',
    report_lease_owner: null,
    report_lease_expires_at: null,
    report_attempts: 0,
    blocked_at: null,
    provider_call_at: null,
    created_at: 1_800_000_000_000,
    updated_at: 1_800_000_000_500,
  };
}

/** Hàng `quarantine` hợp lệ theo đúng 7 cột DDL. */
function validQuarantineRow(): Record<string, unknown> {
  return {
    quarantine_id: 'digest-abc',
    queue_message_id: 'queue-message-1',
    reason: 'unparseable-body',
    field_name: null,
    attempts: 1,
    created_at: 1_800_000_000_000,
    updated_at: 1_800_000_000_000,
  };
}

/** Chạy hàm và trả `rule` của lỗi fail-closed — không có đường "default cho qua". */
function malformedRule(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof MalformedMailJobStateError) {
      return error.rule;
    }
    throw error;
  }
  throw new Error('expected MalformedMailJobStateError, but nothing was thrown');
}

describe('decodeMailJobRow', () => {
  it('decodes a valid row field by field', () => {
    const record = decodeMailJobRow(validRow());

    expect(record).toEqual({
      deliveryId: 'delivery-1',
      messageId: 'message-1',
      dispatchGeneration: 2,
      executionGeneration: 5,
      leaseOwner: 'owner-a',
      leaseExpiresAt: 1_800_000_010_000,
      status: 'processing',
      attempts: 3,
      lastError: 'http-429',
      lastErrorClass: 'retryable',
      providerMessageId: null,
      outcomeReportState: 'none',
      reportLeaseOwner: null,
      reportLeaseExpiresAt: null,
      reportAttempts: 0,
      blockedAt: null,
      providerCallAt: null,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_500,
    });
  });

  it('decodes nullable columns when they are null', () => {
    const record = decodeMailJobRow({
      ...validRow(),
      message_id: null,
      last_error: null,
      last_error_class: null,
    });

    expect(record.messageId).toBeNull();
    expect(record.lastError).toBeNull();
    expect(record.lastErrorClass).toBeNull();
  });

  it('rejects an unknown status instead of defaulting to a usable state', () => {
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), status: 'retrying' }))).toBe(
      'status-enum',
    );
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), status: null }))).toBe(
      'status-enum',
    );
  });

  it('rejects an unknown outcome_report_state', () => {
    expect(
      malformedRule(() => decodeMailJobRow({ ...validRow(), outcome_report_state: 'lost' })),
    ).toBe('outcome-report-state-enum');
  });

  it('rejects counters that are not safe integers', () => {
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), attempts: -1 }))).toBe(
      'counter-negative',
    );
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), attempts: 1.5 }))).toBe(
      'counter-attempts',
    );
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), attempts: '3' }))).toBe(
      'counter-attempts',
    );
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), report_attempts: -1 }))).toBe(
      'counter-negative',
    );
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), execution_generation: -1 }))).toBe(
      'counter-negative',
    );
  });

  it('rejects a dispatch_generation below the schema floor', () => {
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), dispatch_generation: 0 }))).toBe(
      'dispatch-generation-floor',
    );
  });

  it('rejects timestamps that are not safe integers', () => {
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), lease_expires_at: 1.5 }))).toBe(
      'timestamp-lease_expires_at',
    );
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), blocked_at: 'soon' }))).toBe(
      'timestamp-blocked_at',
    );
  });

  it('rejects an empty or non-string delivery_id', () => {
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), delivery_id: '' }))).toBe(
      'string-delivery_id',
    );
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), delivery_id: 7 }))).toBe(
      'string-delivery_id',
    );
  });

  it('rejects an empty string in a nullable column — a writer should have written null', () => {
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), lease_owner: '' }))).toBe(
      'string-lease_owner',
    );
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), last_error: '' }))).toBe(
      'string-last_error',
    );
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), message_id: '' }))).toBe(
      'string-message_id',
    );
  });

  it('re-checks report-state parity even though the schema already encodes it', () => {
    // `sent` + `none`: CHECK của schema có thể không chạy với row đến từ restore/script
    // thủ công — decode là ranh giới tin cậy cuối cùng.
    expect(
      malformedRule(() =>
        decodeMailJobRow({ ...validRow(), status: 'sent', outcome_report_state: 'none' }),
      ),
    ).toBe('report-state-parity');
    expect(
      malformedRule(() =>
        decodeMailJobRow({ ...validRow(), status: 'processing', outcome_report_state: 'pending' }),
      ),
    ).toBe('report-state-parity');
  });

  it('re-checks blocked_at parity', () => {
    // Fixture phải giữ nguyên report-state parity, nếu không lỗi báo ra sẽ là
    // `report-state-parity` (check chạy trước) thay vì lỗi mà ca này đang kiểm.
    expect(
      malformedRule(() =>
        decodeMailJobRow({
          ...validRow(),
          status: 'blocked',
          outcome_report_state: 'pending',
          blocked_at: null,
        }),
      ),
    ).toBe('blocked-at-parity');
    expect(
      malformedRule(() =>
        decodeMailJobRow({
          ...validRow(),
          status: 'sent',
          outcome_report_state: 'pending',
          blocked_at: 1,
        }),
      ),
    ).toBe('blocked-at-parity');
  });

  it('re-checks both lease pairs', () => {
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), lease_expires_at: null }))).toBe(
      'lease-pair-parity',
    );
    expect(malformedRule(() => decodeMailJobRow({ ...validRow(), lease_owner: null }))).toBe(
      'lease-pair-parity',
    );
    expect(
      malformedRule(() =>
        decodeMailJobRow({
          ...validRow(),
          report_lease_owner: 'sweeper-1',
          report_lease_expires_at: null,
        }),
      ),
    ).toBe('report-lease-pair-parity');
    expect(
      malformedRule(() =>
        decodeMailJobRow({
          ...validRow(),
          report_lease_owner: null,
          report_lease_expires_at: 1,
        }),
      ),
    ).toBe('report-lease-pair-parity');
  });
});

describe('decodeQuarantineRow', () => {
  it('decodes a valid sanitized record', () => {
    expect(decodeQuarantineRow(validQuarantineRow())).toEqual({
      quarantineId: 'digest-abc',
      queueMessageId: 'queue-message-1',
      reason: 'unparseable-body',
      fieldName: null,
      attempts: 1,
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
    });
  });

  it('rejects a reason outside the closed set', () => {
    expect(
      malformedRule(() => decodeQuarantineRow({ ...validQuarantineRow(), reason: 'too-large' })),
    ).toBe('quarantine-reason-enum');
  });

  it("requires field_name when reason is 'forbidden-field'", () => {
    expect(
      malformedRule(() =>
        decodeQuarantineRow({ ...validQuarantineRow(), reason: 'forbidden-field' }),
      ),
    ).toBe('quarantine-forbidden-field-name');
    // Có tên key thì hợp lệ — decoder không bao giờ đòi value của key (data policy).
    expect(
      decodeQuarantineRow({
        ...validQuarantineRow(),
        reason: 'forbidden-field',
        field_name: 'generation',
      }).fieldName,
    ).toBe('generation');
  });

  it('enforces the attempts floor of 1', () => {
    expect(malformedRule(() => decodeQuarantineRow({ ...validQuarantineRow(), attempts: 0 }))).toBe(
      'quarantine-attempts-floor',
    );
    expect(
      malformedRule(() => decodeQuarantineRow({ ...validQuarantineRow(), attempts: '1' })),
    ).toBe('counter-attempts');
  });
});

describe('column lists', () => {
  it('pins the exact DDL column order both readers select', () => {
    // Mọi SELECT của repository dùng danh sách này; lệch thứ tự DDL là lệch vị trí cột.
    expect(MAIL_JOB_COLUMNS).toEqual([
      'delivery_id',
      'message_id',
      'dispatch_generation',
      'execution_generation',
      'lease_owner',
      'lease_expires_at',
      'status',
      'attempts',
      'last_error',
      'last_error_class',
      'provider_message_id',
      'outcome_report_state',
      'report_lease_owner',
      'report_lease_expires_at',
      'report_attempts',
      'blocked_at',
      'provider_call_at',
      'created_at',
      'updated_at',
    ]);
    expect(QUARANTINE_COLUMNS).toEqual([
      'quarantine_id',
      'queue_message_id',
      'reason',
      'field_name',
      'attempts',
      'created_at',
      'updated_at',
    ]);
  });
});
