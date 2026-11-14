/**
 * Unit test cho hợp đồng `POST /authorization/verdict` (ADR-0033 Quyết định 3).
 *
 * Phạm vi: **hình dạng** request/response. Hành vi authorization (tập permission
 * hiệu lực, hàng audit `denied`) là việc của tầng database + route và được kiểm
 * ở `tests/integrations/authorization-verdict.spec.ts` với PostgreSQL thật.
 */

import { describe, expect, it } from 'vitest';

import {
  permissionVerdictResponse,
  validatePermissionVerdictRequest,
  VERDICT_CORRELATION_ID_MAX_LENGTH,
} from './authorization-verdict';

const CORRELATION_ID = '7d0f0e0a-4b0c-4b6e-9a3e-1e6c1f2b3c4d';

describe('validatePermissionVerdictRequest', () => {
  it('accepts exactly the two contract fields', () => {
    const result = validatePermissionVerdictRequest({
      permission: 'invitation.create',
      correlation_id: CORRELATION_ID,
    });
    expect(result).toEqual({
      ok: true,
      request: { permission: 'invitation.create', correlation_id: CORRELATION_ID },
    });
  });

  it('rejects a body that is not a JSON object', () => {
    for (const payload of [null, [], 'invitation.create', 42]) {
      expect(validatePermissionVerdictRequest(payload).ok).toBe(false);
    }
  });

  it('rejects extra fields instead of ignoring them', () => {
    // `actor_staff_id` trong body là đúng thứ contract cấm: identity do
    // `staff-access` phân giải từ envelope, không do caller khai (ADR-0033).
    const result = validatePermissionVerdictRequest({
      permission: 'invitation.create',
      correlation_id: CORRELATION_ID,
      actor_staff_id: 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a permission that is not exactly "<domain>.<action>"', () => {
    for (const permission of [
      'invitation',
      'invitation.',
      '.create',
      'invitation.create.extra',
      'invitation:*',
      '*',
      42,
      undefined,
    ]) {
      const result = validatePermissionVerdictRequest({
        permission,
        correlation_id: CORRELATION_ID,
      });
      expect(result.ok, `permission ${String(permission)} must be rejected`).toBe(false);
    }
  });

  it('rejects a missing, empty or oversized correlation_id', () => {
    for (const correlation_id of [
      undefined,
      '',
      42,
      'x'.repeat(VERDICT_CORRELATION_ID_MAX_LENGTH + 1),
    ]) {
      const result = validatePermissionVerdictRequest({
        permission: 'invitation.create',
        correlation_id,
      });
      expect(result.ok).toBe(false);
    }
    expect(
      validatePermissionVerdictRequest({
        permission: 'invitation.create',
        correlation_id: 'x'.repeat(VERDICT_CORRELATION_ID_MAX_LENGTH),
      }).ok,
    ).toBe(true);
  });

  it('does not echo the caller value in a rejection detail', () => {
    const result = validatePermissionVerdictRequest({
      permission: 'no-dot-here',
      correlation_id: CORRELATION_ID,
    });
    expect(result).toEqual({
      ok: false,
      detail: expect.not.stringContaining('no-dot-here'),
    });
  });
});

describe('permissionVerdictResponse', () => {
  it('carries exactly the two wire fields', () => {
    expect(permissionVerdictResponse('allowed', 'staff-id')).toEqual({
      verdict: 'allowed',
      actor_staff_id: 'staff-id',
    });
    expect(permissionVerdictResponse('denied', 'staff-id')).toEqual({
      verdict: 'denied',
      actor_staff_id: 'staff-id',
    });
  });
});
