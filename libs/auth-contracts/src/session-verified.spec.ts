import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ACR_URN_VALUES,
  FORBIDDEN_SESSION_VERIFIED_FIELDS,
  REQUIRED_SESSION_VERIFIED_FIELDS,
  validateSessionVerifiedRequest,
  type SessionVerifiedRejectionReason,
  type SessionVerifiedRequest,
  type SessionVerifiedValidation,
} from './session-verified';

const VALID: SessionVerifiedRequest = {
  handle: 'handle-X',
  sub: 'sub_abcdefghijklmnopqrstuvwxyz234567',
  acr: 'urn:ecoma:acr:email-otp',
  authn_at: 1_700_000_000_000,
  account_session_ref: 'asr_123',
  event_id: 'evt_123',
};

/**
 * Assert validation thất bại với `reason` và `detail` chứa `field`.
 *
 * Gộp vào một hàm để không phải bọc `expect` trong nhánh `if (!result.ok)`
 * (`no-conditional-expect`); nhánh hợp lệ vẫn fail ngay với giá trị thật.
 */
function expectRejectedBy(
  result: SessionVerifiedValidation,
  reason: SessionVerifiedRejectionReason,
  field: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the payload to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(field);
}

/**
 * Bóc giá trị khi validation thành công, ném lỗi khi thất bại.
 *
 * Nhờ vậy `expect` sau đó không nằm trong nhánh điều kiện (`no-conditional-expect`), và
 * nhánh thất bại vẫn fail với thông báo rõ ràng thay vì im lặng bỏ qua assertion.
 */
function unwrap(result: SessionVerifiedValidation): SessionVerifiedRequest {
  if (!result.ok) {
    throw new Error(`Expected a valid payload, got ${result.reason}: ${result.detail}`);
  }
  return result.request;
}

describe('validateSessionVerifiedRequest — accept', () => {
  it('accepts a payload with exactly the six required fields', () => {
    expect(unwrap(validateSessionVerifiedRequest({ ...VALID }))).toEqual(VALID);
  });

  it('accepts every declared ACR URN', () => {
    for (const acr of ACR_URN_VALUES) {
      const result = validateSessionVerifiedRequest({ ...VALID, acr });
      expect(result.ok).toBe(true);
    }
  });

  it('accepts authn_at of zero, which is falsy but valid', () => {
    // `authn_at` nằm trong danh sách trường bắt buộc: kiểm tra kiểu falsy-sẽ-qua ở đây
    // là một lỗi thật, dù epoch 0 có nghĩa trong thực tế.
    const result = validateSessionVerifiedRequest({ ...VALID, authn_at: 0 });
    expect(result.ok).toBe(true);
  });

  it('returns a copy that carries only the six fields', () => {
    const result = validateSessionVerifiedRequest({ ...VALID, extra: 'ignored' });
    // `extra` không thuộc nhóm cấm nên không bị chặn, nhưng KHÔNG được đi vào request.
    // So bằng membership chứ không sort: `unicorn/no-array-sort` cấm `sort()` còn
    // `lib` của tsconfig.base là es2022 nên không có `toSorted()`.
    const keys = Object.keys(unwrap(result));
    expect(keys).toHaveLength(REQUIRED_SESSION_VERIFIED_FIELDS.length);
    for (const field of REQUIRED_SESSION_VERIFIED_FIELDS) {
      expect(keys).toContain(field);
    }
  });
});

describe('validateSessionVerifiedRequest — missing required fields', () => {
  it.each([...REQUIRED_SESSION_VERIFIED_FIELDS])('rejects a payload missing %s', (field) => {
    const payload: Record<string, unknown> = { ...VALID };
    Reflect.deleteProperty(payload, field);
    const result = validateSessionVerifiedRequest(payload);
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'missing_field', field);
  });

  it('rejects an empty object', () => {
    const result = validateSessionVerifiedRequest({});
    expect(result).toMatchObject({ ok: false, reason: 'missing_field' });
  });
});

describe('validateSessionVerifiedRequest — forbidden fields (FR-006f)', () => {
  it.each([...FORBIDDEN_SESSION_VERIFIED_FIELDS])('rejects a payload carrying %s', (field) => {
    const result = validateSessionVerifiedRequest({ ...VALID, [field]: 'anything' });
    expect(result.ok).toBe(false);
    expectRejectedBy(result, 'forbidden_field', field);
  });

  it('covers exactly the documented substitution fields', () => {
    expect(FORBIDDEN_SESSION_VERIFIED_FIELDS).toEqual([
      'client_id',
      'redirect_uri',
      'scope',
      'state',
      'nonce',
      'code_challenge',
      'code_verifier',
    ]);
  });

  it('rejects a forbidden field even when its value is null', () => {
    // Có mặt là đủ — `redirect_uri: null` vẫn là một payload đã bị điền tay, không phải
    // payload nguyên bản của provider.
    const result = validateSessionVerifiedRequest({ ...VALID, redirect_uri: null });
    expect(result).toMatchObject({ ok: false, reason: 'forbidden_field' });
  });

  it('rejects a forbidden field even when its value is undefined', () => {
    const result = validateSessionVerifiedRequest({ ...VALID, scope: undefined });
    expect(result.ok).toBe(false);
  });

  it('rejects a forbidden field with an empty-string value', () => {
    const result = validateSessionVerifiedRequest({ ...VALID, client_id: '' });
    expect(result.ok).toBe(false);
  });

  it('rejects a forbidden field alongside a missing required field', () => {
    // Nhóm cấm phải thắng: nếu báo missing_field thì lỗi bị gán sai chỗ và code có thể
    // "sửa" bằng cách điền thêm trường thay vì gỡ trường cấm.
    const payload: Record<string, unknown> = { ...VALID, state: 'x' };
    Reflect.deleteProperty(payload, 'event_id');
    expect(validateSessionVerifiedRequest(payload)).toMatchObject({
      ok: false,
      reason: 'forbidden_field',
    });
  });
});

describe('validateSessionVerifiedRequest — invalid shapes', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'handle-X'],
    ['a number', 42],
    ['an array', [VALID]],
    ['a boolean', true],
  ])('rejects %s', (_label, payload) => {
    expect(validateSessionVerifiedRequest(payload)).toMatchObject({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it.each([
    ['an acr not in the declared set', { acr: 'urn:ecoma:acr:sms' }],
    ['an acr with the wrong namespace', { acr: 'urn:other:acr:email-otp' }],
    ['an acr uppercase', { acr: 'urn:ecoma:acr:EMAIL-OTP' }],
    ['an acr empty', { acr: '' }],
    ['an acr of the old ladder shape', { acr: 'password' }],
    ['an acr of wrong type', { acr: 2 }],
  ])('rejects %s', (_label, override) => {
    const result = validateSessionVerifiedRequest({ ...VALID, ...override });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([
    ['handle', { handle: '' }],
    ['sub', { sub: '' }],
    ['account_session_ref', { account_session_ref: '' }],
    ['event_id', { event_id: '' }],
  ])('rejects an empty %s', (_field, override) => {
    const result = validateSessionVerifiedRequest({ ...VALID, ...override });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });

  it.each([
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '1700000000000'],
    ['null', null],
  ])('rejects a %s authn_at', (_label, authn_at) => {
    const result = validateSessionVerifiedRequest({ ...VALID, authn_at });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_payload' });
  });
});

describe('validateSessionVerifiedRequest — detail never leaks payload values', () => {
  it('names the offending field without echoing its value', () => {
    const result = validateSessionVerifiedRequest({
      ...VALID,
      redirect_uri: 'https://attacker.example/steal',
    });
    expect(result).toMatchObject({ ok: false, reason: 'forbidden_field' });
    if (result.ok) {
      throw new Error('Expected the payload to be rejected, but it was accepted.');
    }
    expect(result.detail).not.toContain('attacker.example');
    expect(result.detail).toContain('redirect_uri');
  });
});

describe('ACR_URN_VALUES — parity with the domain producer', () => {
  // ⚠️ Đọc file nguồn của producer (`libs/account-domain/src/acr.ts`) chứ KHÔNG
  // import: constraint `type:contracts` cấm phụ thuộc `type:domain` (kể cả
  // transitive), nên so sánh qua import là bất khả thi về mặt kiến trúc — chính
  // vì thế tên URN được mirror tại đây. Test này đọc nguồn producer (cùng pattern
  // `readFileSync` của `libs/backoffice-domain/src/account-id.spec.ts`), bóc URN
  // trong `ACR` của producer và assert hai tập bằng nhau: producer đổi URN mà
  // không sửa bên contract → test đỏ trước khi sai khác chạm tới wire.
  const producerSource = readFileSync(
    resolve(import.meta.dirname, '../../account-domain/src/acr.ts'),
    'utf8',
  );

  // Bóc đúng khối `ACR = {...} as const` của producer — các URN khác trong file
  // (doc comment, regex `isAcrShape`) không được lọt vào tập so sánh. Mảng
  // `ACR_VALUES` tham chiếu qua tên property, nên URN phải lấy từ khối object.
  const block = /export const ACR = \{([^}]*)\} as const/u.exec(producerSource);
  const producerUrns =
    block?.[1].match(/'urn:ecoma:acr:[^']+'/gu)?.map((quoted) => quoted.slice(1, -1)) ?? [];

  it('equals exactly the ACR set the domain declares', () => {
    expect(block).not.toBeNull();
    expect(producerUrns.length).toBeGreaterThan(0);
    // So tập không so vị trí: thứ tự khai báo không thuộc wire contract — chỉ
    // thành viên của tập là. So bằng membership thay vì sort:
    // `unicorn/no-array-sort` cấm `sort()` và tsconfig.base của repo là es2022
    // nên không có `toSorted()`.
    expect(producerUrns).toHaveLength(ACR_URN_VALUES.length);
    for (const urn of ACR_URN_VALUES) {
      expect(producerUrns).toContain(urn);
    }
  });

  it('keeps the same declaration order as the domain source', () => {
    // `toEqual` trên array là so có thứ tự: cùng thứ tự với `ACR_VALUES`
    // (email-otp → mfa → phishing-resistant) giữ tài liệu contract và nguồn
    // domain cùng một trục đọc — lệch thứ tự là dấu hiệu một bên đã được sửa
    // tay mà bên kia chưa.
    expect([...ACR_URN_VALUES]).toEqual(producerUrns);
  });
});
