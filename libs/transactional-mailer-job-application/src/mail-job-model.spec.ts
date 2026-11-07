import { describe, expect, it } from 'vitest';

import {
  MAIL_JOB_BUDGET_EXHAUSTED_ERROR_CLASS,
  MAIL_JOB_DELIVERY_NOT_FOUND_ERROR_CLASS,
  MAIL_JOB_PERSISTABLE_STATUS_VALUES,
  MAIL_JOB_REPORTABLE_STATE_VALUES,
  MAIL_JOB_STATUS_VALUES,
  OUTCOME_REPORT_STATE_VALUES,
  QUARANTINE_FIELD_NAME_MAX_LENGTH,
  QUARANTINE_REASON_VALUES,
  SANITIZED_ERROR_TOKEN_MAX_LENGTH,
  SANITIZED_ERROR_TOKEN_PATTERN,
  MAIL_JOB_IDENTIFIER_MAX_LENGTH,
  MailJobValidationError,
  assertBoundedOptionalString,
  assertBoundedString,
  assertClosedValue,
  assertLeaseOwner,
  assertNonEmptyString,
  assertPositiveInteger,
  assertSafeInteger,
  sanitizeErrorToken,
  sanitizeFieldName,
} from './mail-job-model';

/** Bắt lỗi và trả `code` của nó — mỗi validator đều có code riêng để caller phân biệt. */
function validationErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof MailJobValidationError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected MailJobValidationError, but nothing was thrown');
}

describe('closed value sets', () => {
  it('pins the canonical enum values of every closed column', () => {
    expect(MAIL_JOB_STATUS_VALUES).toEqual(['processing', 'sent', 'failed', 'blocked']);
    expect(OUTCOME_REPORT_STATE_VALUES).toEqual([
      'none',
      'pending',
      'reported',
      'superseded',
      'orphaned',
    ]);
    expect(QUARANTINE_REASON_VALUES).toEqual([
      'missing-delivery-id',
      'unparseable-body',
      'unsupported-version',
      'forbidden-field',
      // §11.3: message lifecycle event sai cấu trúc vào quarantine cùng bảng, reason riêng.
      'lifecycle-event-invalid',
    ]);
    // §9.2.2 hàng 1–4: persist result chỉ được ghi ba trạng thái terminal-theo-execution.
    expect(MAIL_JOB_PERSISTABLE_STATUS_VALUES).toEqual(['sent', 'failed', 'blocked']);
    // §9.5: chốt terminal cho report; `pending` là operation riêng (keepReportPending).
    expect(MAIL_JOB_REPORTABLE_STATE_VALUES).toEqual(['reported', 'superseded', 'orphaned']);
    expect(MAIL_JOB_BUDGET_EXHAUSTED_ERROR_CLASS).toBe('execution-budget-exhausted');
    expect(MAIL_JOB_DELIVERY_NOT_FOUND_ERROR_CLASS).toBe('delivery-not-found');
  });
});

describe('sanitizeErrorToken', () => {
  it('accepts the documented token vocabulary', () => {
    expect(sanitizeErrorToken('http-429', 'lastError')).toBe('http-429');
    expect(sanitizeErrorToken('malformed-response', 'lastError')).toBe('malformed-response');
    expect(sanitizeErrorToken('execution-budget-exhausted', 'lastErrorClass')).toBe(
      'execution-budget-exhausted',
    );
    expect(sanitizeErrorToken('a', 'lastError')).toBe('a');
    expect(sanitizeErrorToken('a'.repeat(SANITIZED_ERROR_TOKEN_MAX_LENGTH), 'lastError')).toBe(
      'a'.repeat(SANITIZED_ERROR_TOKEN_MAX_LENGTH),
    );
    expect(sanitizeErrorToken('1', 'lastError')).toBe('1');
    expect(sanitizeErrorToken('12', 'lastError')).toBe('12');
  });

  it('passes null through so writers can clear a column', () => {
    expect(sanitizeErrorToken(null, 'lastError')).toBeNull();
  });

  it('rejects free-form or personal data before it can reach last_error', () => {
    expect(
      validationErrorCode(() => sanitizeErrorToken('nguoi-nhan@example.test', 'lastError')),
    ).toBe('error-token-pattern');
    expect(validationErrorCode(() => sanitizeErrorToken('HTTP-429', 'lastError'))).toBe(
      'error-token-pattern',
    );
    expect(validationErrorCode(() => sanitizeErrorToken('timeout: d=1', 'lastError'))).toBe(
      'error-token-pattern',
    );
    expect(validationErrorCode(() => sanitizeErrorToken(' leading-space', 'lastError'))).toBe(
      'error-token-pattern',
    );
    expect(validationErrorCode(() => sanitizeErrorToken('-leading-dash', 'lastError'))).toBe(
      'error-token-pattern',
    );
    expect(validationErrorCode(() => sanitizeErrorToken('trailing-', 'lastError'))).toBe(
      'error-token-pattern',
    );
  });

  it('rejects empty and oversized tokens', () => {
    expect(validationErrorCode(() => sanitizeErrorToken('', 'lastError'))).toBe(
      'error-token-length',
    );
    expect(
      validationErrorCode(() =>
        sanitizeErrorToken('a'.repeat(SANITIZED_ERROR_TOKEN_MAX_LENGTH + 1), 'lastError'),
      ),
    ).toBe('error-token-length');
    // Pattern cho phép tối đa 64 ký tự; token 65 ký tự phải trượt length check trước.
    expect(SANITIZED_ERROR_TOKEN_PATTERN.test('a'.repeat(65))).toBe(false);
  });
});

describe('sanitizeFieldName', () => {
  it('accepts every documented forbidden key, including snake_case', () => {
    // `api_key` là ví dụ tường minh trong 02-requirements.md §FR-... (forbidden-field).
    // Dùng chung sanitizer kebab-case của error token sẽ từ chối chính key này.
    for (const key of ['secret', 'token', 'recipient', 'api_key', 'subject', 'body']) {
      expect(sanitizeFieldName(key, 'fieldName')).toBe(key);
    }
    // Case-sensitive như JSON key thật, không lowercase hoá.
    expect(sanitizeFieldName('myField', 'fieldName')).toBe('myField');
    expect(sanitizeFieldName('Content-Type', 'fieldName')).toBe('Content-Type');
    expect(sanitizeFieldName('a.b-c_d', 'fieldName')).toBe('a.b-c_d');
    expect(
      sanitizeFieldName('a'.repeat(QUARANTINE_FIELD_NAME_MAX_LENGTH), 'fieldName'),
    ).toHaveLength(QUARANTINE_FIELD_NAME_MAX_LENGTH);
  });

  it('rejects free-form, oversized or empty names before they reach persisted state', () => {
    // Tên key là dữ liệu đến từ payload không tin cậy: phải bound (§6), không nhận
    // khoảng trắng/ký tự control/dấu quote — đó là đường biến đổi value thành "tên".
    expect(validationErrorCode(() => sanitizeFieldName('has space', 'fieldName'))).toBe(
      'field-name-pattern',
    );
    expect(validationErrorCode(() => sanitizeFieldName('line\nbreak', 'fieldName'))).toBe(
      'field-name-pattern',
    );
    expect(validationErrorCode(() => sanitizeFieldName("quote'", 'fieldName'))).toBe(
      'field-name-pattern',
    );
    expect(validationErrorCode(() => sanitizeFieldName('', 'fieldName'))).toBe(
      'field-name-pattern',
    );
    expect(validationErrorCode(() => sanitizeFieldName('a'.repeat(129), 'fieldName'))).toBe(
      'field-name-pattern',
    );
  });
});

describe('assertSafeInteger', () => {
  it('accepts integers inside the safe range', () => {
    expect(assertSafeInteger(0, 'attempts')).toBe(0);
    expect(assertSafeInteger(-1, 'offset')).toBe(-1);
    expect(assertSafeInteger(2 ** 53 - 1, 'max')).toBe(2 ** 53 - 1);
  });

  it('rejects non-integers and out-of-range values with distinct codes', () => {
    expect(validationErrorCode(() => assertSafeInteger(1.5, 'attempts'))).toBe('integer-type');
    expect(validationErrorCode(() => assertSafeInteger(Number.NaN, 'attempts'))).toBe(
      'integer-type',
    );
    expect(validationErrorCode(() => assertSafeInteger(2 ** 53, 'attempts'))).toBe('integer-range');
  });
});

describe('assertPositiveInteger', () => {
  it('accepts integers >= 1', () => {
    expect(assertPositiveInteger(1, 'dispatchGeneration')).toBe(1);
    expect(assertPositiveInteger(99, 'maxExecutionAttempts')).toBe(99);
  });

  it('rejects zero and negatives so a budget or lease length cannot silently disable a guard', () => {
    expect(validationErrorCode(() => assertPositiveInteger(0, 'leaseMs'))).toBe('integer-positive');
    expect(validationErrorCode(() => assertPositiveInteger(-1, 'dispatchGeneration'))).toBe(
      'integer-positive',
    );
    expect(validationErrorCode(() => assertPositiveInteger(1.5, 'leaseMs'))).toBe('integer-type');
  });
});

describe('assertClosedValue', () => {
  it('returns the value when it belongs to the closed set', () => {
    expect(assertClosedValue('sent', MAIL_JOB_PERSISTABLE_STATUS_VALUES, 'outcome')).toBe('sent');
    expect(assertClosedValue('superseded', MAIL_JOB_REPORTABLE_STATE_VALUES, 'disposition')).toBe(
      'superseded',
    );
  });

  it('rejects values outside the set before any statement touches D1', () => {
    expect(
      validationErrorCode(() =>
        assertClosedValue('processing', MAIL_JOB_PERSISTABLE_STATUS_VALUES, 'outcome'),
      ),
    ).toBe('closed-value');
    expect(
      validationErrorCode(() => assertClosedValue('retrying', MAIL_JOB_STATUS_VALUES, 'status')),
    ).toBe('closed-value');
  });
});

describe('assertNonEmptyString and assertLeaseOwner', () => {
  it('accepts a normal identifier and a 128-code-point owner', () => {
    expect(assertNonEmptyString('delivery-1', 'deliveryId')).toBe('delivery-1');
    expect(assertLeaseOwner('a'.repeat(128), 'owner')).toHaveLength(128);
  });

  it('rejects an empty identifier', () => {
    expect(validationErrorCode(() => assertNonEmptyString('', 'deliveryId'))).toBe(
      'string-non-empty',
    );
    expect(validationErrorCode(() => assertLeaseOwner('', 'owner'))).toBe('string-non-empty');
  });

  it('rejects an owner longer than 128 code points', () => {
    expect(validationErrorCode(() => assertLeaseOwner('a'.repeat(129), 'owner'))).toBe(
      'lease-owner-length',
    );
    // Đếm theo code point, không theo byte: một owner 129 emoji vẫn bị chặn.
    expect(validationErrorCode(() => assertLeaseOwner('😀'.repeat(129), 'owner'))).toBe(
      'lease-owner-length',
    );
  });
});

describe('assertBoundedString', () => {
  it('accepts a normal identifier at the exact bound', () => {
    expect(
      assertBoundedString('d'.repeat(MAIL_JOB_IDENTIFIER_MAX_LENGTH), 'deliveryId'),
    ).toHaveLength(MAIL_JOB_IDENTIFIER_MAX_LENGTH);
  });

  it('rejects empty and over-bound identifiers', () => {
    expect(validationErrorCode(() => assertBoundedString('', 'deliveryId'))).toBe(
      'string-non-empty',
    );
    expect(validationErrorCode(() => assertBoundedString('d'.repeat(129), 'deliveryId'))).toBe(
      'string-deliveryId-too-long',
    );
    // Bound tính theo code point: 129 emoji cũng bị chặn dù byte ít hơn nhiều.
    expect(validationErrorCode(() => assertBoundedString('😀'.repeat(129), 'deliveryId'))).toBe(
      'string-deliveryId-too-long',
    );
  });
});

describe('assertBoundedOptionalString', () => {
  it('maps undefined to null and passes a value through', () => {
    expect(assertBoundedOptionalString(undefined, 'messageId')).toBeNull();
    expect(assertBoundedOptionalString('message-1', 'messageId')).toBe('message-1');
  });

  it('rejects empty string — decoder treats "" in a nullable column as malformed', () => {
    expect(validationErrorCode(() => assertBoundedOptionalString('', 'messageId'))).toBe(
      'string-non-empty',
    );
    expect(validationErrorCode(() => assertBoundedOptionalString('', 'providerMessageId'))).toBe(
      'string-non-empty',
    );
  });

  it('rejects values longer than the bound', () => {
    expect(
      validationErrorCode(() => assertBoundedOptionalString('m'.repeat(129), 'providerMessageId')),
    ).toBe('string-providerMessageId-too-long');
  });
});
