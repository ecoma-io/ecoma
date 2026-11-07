/**
 * Ghim định dạng và entropy threshold của `BackofficeAccountId`.
 *
 * ⚠️ Đây là test cho **constraint type** — lib thuần không có policy runtime.
 * 1:1 mapping giữa staff và Account ID được enforce ở tầng DB (PRIMARY KEY
 * trên `staff.sub`) và tầng application, không ở lib này.
 *
 * F1 (issue #101): định danh này là reference tới `sub` mà `account` cấp, nên
 * format của nó phải ĐỒNG NHẤT format `Subject` của account-domain. Ba test
 * cùng giữ khớp đó — ghim giá trị, ghim `sub` thật 32 ký tự đi qua guard, và
 * đọc file nguồn producer để hai bên không lệch nhau âm thầm.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BACKOFFICE_ACCOUNT_ID_ENTROPY_BITS,
  BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS,
  BACKOFFICE_ACCOUNT_ID_MIN_ENTROPY_BITS,
  BACKOFFICE_ACCOUNT_ID_PREFIX,
  backofficeAccountIdEntropy,
  createBackofficeAccountId,
  isBackofficeAccountId,
} from './account-id';

/** Entropy hợp lệ — đúng độ dài, đúng alphabet. */
const ENTROPY = 'a'.repeat(BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS);

describe('entropy threshold', () => {
  it('matches the entropy the identity producer issues, not a local guess', () => {
    // Ngưỡng của reference là ngưỡng của producer: 32 × 5 = 160 bit, đúng con số
    // `Subject` của `account` phát hành. Một cặp (chars, min_bits) không cùng
    // hệ — hay cả hai cùng lệch khỏi producer — phải đỏ ở đây.
    expect(BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS).toBe(32);
    expect(BACKOFFICE_ACCOUNT_ID_MIN_ENTROPY_BITS).toBe(160);
    expect(BACKOFFICE_ACCOUNT_ID_ENTROPY_BITS).toBe(BACKOFFICE_ACCOUNT_ID_MIN_ENTROPY_BITS);
    expect(BACKOFFICE_ACCOUNT_ID_ENTROPY_BITS).toBe(BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS * 5);
  });

  it('accepts exactly the 32-char subject the account service issues', () => {
    // Trước F1 hằng là 52 nên `sub_` + 32 ký tự BỊ TỪ CHỐI — đây là test đỏ
    // khi bỏ fix: định danh thật không qua được guard, tức 503 vĩnh viễn.
    const issued = `${BACKOFFICE_ACCOUNT_ID_PREFIX}${'a'.repeat(32)}`;
    expect(isBackofficeAccountId(issued)).toBe(true);
    // 52 ký tự là format local cũ đã bị gỡ — look-alike không còn được nhận.
    expect(isBackofficeAccountId(`${BACKOFFICE_ACCOUNT_ID_PREFIX}${'a'.repeat(52)}`)).toBe(false);
  });

  it('agrees with the account producer by reading its source (no cross-scope import)', () => {
    // ⚠️ Đọc file nguồn của `libs/account-domain` chứ KHÔNG import: module-
    // boundary cấm `backoffice-domain` phụ thuộc implementation của identity BC,
    // và thêm cạnh đó chỉ để lấy hai con số là một thay đổi kiến trúc, không phải
    // một test (cùng pattern mà `internal-nonces.spec.ts` cross-check hằng của
    // `internal-auth-contracts` bằng readFileSync). Producer đổi độ dài mà không sửa
    // bên đây → test này đỏ trước khi hai `sub` lệch format ở runtime.
    const producerSource = readFileSync(
      resolve(import.meta.dirname, '../../account-domain/src/subject.ts'),
      'utf8',
    );

    const length = /SUBJECT_ENTROPY_LENGTH = (\d+)/u.exec(producerSource);
    expect(length).not.toBeNull();
    expect(BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS).toBe(Number(length?.[1]));

    const prefix = /SUBJECT_PREFIX = '([^']+)'/u.exec(producerSource);
    expect(prefix).not.toBeNull();
    expect(BACKOFFICE_ACCOUNT_ID_PREFIX).toBe(prefix?.[1]);
  });

  it('keeps the alphabet lowercase base32 without the digits silhouette', () => {
    // Sử dụng một entropy ngoài alphabet phải fail create → constraint alphabet
    //ownership gắn với guard ăn khớp là bất biến.
    const outsideAlphabet = `${'g'.repeat(BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS - 1)}8`;
    expect(() => createBackofficeAccountId(outsideAlphabet)).toThrow(TypeError);
  });
});

describe('type guard', () => {
  it('accepts the well-formed id and rejects look-alikes', () => {
    const accountId = createBackofficeAccountId(ENTROPY);
    expect(isBackofficeAccountId(accountId)).toBe(true);
    expect(isBackofficeAccountId(`${BACKOFFICE_ACCOUNT_ID_PREFIX}${ENTROPY.slice(0, -1)}G`)).toBe(
      false,
    );
    // 31 ký tự — ngắn hơn format producer.
    expect(isBackofficeAccountId(`${BACKOFFICE_ACCOUNT_ID_PREFIX}${'a'.repeat(31)}`)).toBe(false);
    expect(isBackofficeAccountId(`staff_${ENTROPY}`)).toBe(false);
    expect(isBackofficeAccountId(undefined)).toBe(false);
    expect(isBackofficeAccountId(null)).toBe(false);
  });
});

describe('createBackofficeAccountId', () => {
  it('prefixes the given entropy and returns a valid id', () => {
    const accountId = createBackofficeAccountId(ENTROPY);
    expect(accountId.startsWith(BACKOFFICE_ACCOUNT_ID_PREFIX)).toBe(true);
    expect(backofficeAccountIdEntropy(accountId)).toBe(ENTROPY);
  });

  it('rejects non-string entropy and wrong lengths', () => {
    expect(() => createBackofficeAccountId(undefined as unknown as string)).toThrow(TypeError);
    expect(() => createBackofficeAccountId('')).toThrow(TypeError);
    expect(() =>
      createBackofficeAccountId('a'.repeat(BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS - 1)),
    ).toThrow(TypeError);
    expect(() => createBackofficeAccountId(`${ENTROPY}a`)).toThrow(TypeError);
  });
});

describe('opaque brand', () => {
  it('keeps the value exactly the string it wraps', () => {
    // Brand chỉ là marker type-level, không thêm property runtime nào: value
    // đọc lại bằng `String()` phải đúng chuỗi đã tạo.
    expect(String(createBackofficeAccountId(ENTROPY))).toBe(
      `${BACKOFFICE_ACCOUNT_ID_PREFIX}${ENTROPY}`,
    );
  });
});
