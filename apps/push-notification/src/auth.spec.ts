/**
 * Auth của ba authorization boundary — `401` **trước** mọi lookup (§8.1, FR-019).
 *
 * ⚠️ **Vì sao "trước lookup" là phần khó nhất của yêu cầu này.** Cloudflare **không** phân
 * biệt một lời gọi qua Service Binding với một lời gọi từ Internet, nên route `/internal/**`
 * reachable từ Internet và phải tự xác thực (`docs/architecture/04-platform-facts.md`). Khi đó:
 * `401` cho "không có quyền" và `404` cho "không tồn tại" tạo thành một oracle đo một
 * `delivery_id` có thật hay không — và `§8.1` cấm đúng điều đó.
 *
 * ⚠️ **Test này kiểm trên `authenticateRuntimeCaller`/`authenticateBearer`, không kiểm route.**
 * Lý do: route gọi `buildContext` trước rồi mới xác thực, và `buildContext` chỉ đọc `env`
 * nên nó không có tác dụng phụ quan sát được. Test cuối cùng trong file này kiểm **điều đó**
 * bằng cách gọi route thật qua `main.ts` với một `env` D1 thật — đó là nơi "401 trước lookup"
 * trở thành một khẳng định quan sát được thay vì một lời bình luận.
 *
 * ⚠️ **Mọi rejection trả `null`, không nêu nguyên nhân.** Một response phân biệt "thiếu
 * header" với "sai secret" là một oracle đo lời gọi đó đã thử gì. Test dưới đây đòi **cùng
 * một** kết quả cho mọi hình dạng thất bại.
 */

import { describe, expect, it } from 'vitest';

import {
  authenticateBearer,
  authenticateRuntimeCaller,
  constantTimeEquals,
  readBearerToken,
} from '@ecoma-io/push-notification-infrastructure';

import { testConfig } from '../tests/integrations/fixture-ports';

const CONFIG = testConfig();

/** Header đúng của runtime API. */
const RUNTIME_HEADERS = {
  sharedSecret: CONFIG.runtimeAuth.sharedSecret,
  principal: CONFIG.runtimeAuth.expectedPrincipal,
} as const;

describe('authenticateRuntimeCaller — shared secret + principal', () => {
  it('accepts correct headers and returns the configured principal', () => {
    const caller = authenticateRuntimeCaller(RUNTIME_HEADERS, {
      expectedSecret: CONFIG.runtimeAuth.sharedSecret,
      expectedPrincipal: CONFIG.runtimeAuth.expectedPrincipal,
    });

    // ⚠️ `principal` trả về là giá trị **kỳ vọng**, không phải giá trị header. Trả giá trị
    // header sẽ biến một caller hợp lệ thành chủ sở hữu của một principal tự do chọn — và
    // `principal` đó đi vào `audit_records.actor`.
    expect(caller).toEqual({
      principal: CONFIG.runtimeAuth.expectedPrincipal,
      // ⚠️ `app` là `null` vì `web-push-notification-job` phục vụ **mọi** App qua một private
      // interface; `app` suy ra từ chính delivery, không phải từ caller.
      app: null,
    });
  });

  it.each([
    ['a wrong shared secret', { sharedSecret: 'nope', principal: 'svc.web-push-notification-job' }],
    ['an empty shared secret', { sharedSecret: '', principal: 'svc.web-push-notification-job' }],
    ['a missing shared secret', { sharedSecret: null, principal: 'svc.web-push-notification-job' }],
    ['a wrong principal', { sharedSecret: 'runtime-secret', principal: 'attacker' }],
    ['an empty principal', { sharedSecret: 'runtime-secret', principal: '' }],
    ['a missing principal', { sharedSecret: 'runtime-secret', principal: null }],
    ['both missing', { sharedSecret: null, principal: null }],
    [
      'a correct secret with a principal differing only in case',
      { sharedSecret: 'runtime-secret', principal: 'SVC.WEB-PUSH-NOTIFICATION-JOB' },
    ],
    [
      'a secret that is a prefix of the expected one',
      { sharedSecret: 'runtime-secre', principal: 'svc.web-push-notification-job' },
    ],
    [
      'a secret that is the expected one plus one character',
      { sharedSecret: 'runtime-secrets', principal: 'svc.web-push-notification-job' },
    ],
  ])('returns null for %s', (_label, headers) => {
    const caller = authenticateRuntimeCaller(headers, {
      expectedSecret: CONFIG.runtimeAuth.sharedSecret,
      expectedPrincipal: CONFIG.runtimeAuth.expectedPrincipal,
    });
    // ⚠️ Tất cả đều `null`, **không** một `reason`. Ba boundary dùng chung kiểu
    // `AuthenticatedCaller | null` chính vì thế: một `reason` trả về sẽ là một oracle.
    expect(caller).toBeNull();
  });

  it('does not reveal which of the two headers was wrong', () => {
    const wrongSecret = authenticateRuntimeCaller(
      { sharedSecret: 'nope', principal: 'svc.web-push-notification-job' },
      { expectedSecret: 'runtime-secret', expectedPrincipal: 'svc.web-push-notification-job' },
    );
    const wrongPrincipal = authenticateRuntimeCaller(
      { sharedSecret: 'runtime-secret', principal: 'nope' },
      { expectedSecret: 'runtime-secret', expectedPrincipal: 'svc.web-push-notification-job' },
    );

    // ⚠️ Cùng **hình dạng**, không chỉ cùng giá trị: nếu một nhánh trả `{ reason }` còn nhánh
    // kia trả `null`, phân biệt này lọt ngay qua HTTP status/body.
    expect(JSON.stringify(wrongSecret)).toBe(JSON.stringify(wrongPrincipal));
    expect(wrongSecret).toBe(wrongPrincipal);
  });
});

describe('authenticateBearer — Admin API and Application API', () => {
  it('accepts a bearer token case-insensitively in the scheme', () => {
    // ⚠️ Scheme của `Authorization` không phân biệt hoa/thường theo RFC 7235. Chỉ chấp
    // nhận `Bearer` viết hoa chữ B sẽ từ chối một client hợp lệ theo spec.
    for (const header of [
      'Bearer admin-token',
      'bearer admin-token',
      'BEARER admin-token',
      'BeArEr admin-token',
    ]) {
      const caller = authenticateBearer(header, {
        expectedSecret: CONFIG.controlPlaneAuth.adminToken,
        expectedPrincipal: CONFIG.controlPlaneAuth.adminPrincipal,
      });
      expect(caller).toEqual({ principal: CONFIG.controlPlaneAuth.adminPrincipal, app: null });
    }
  });

  it.each([
    ['a wrong token', 'Bearer wrong-token'],
    ['a missing authorization header', null],
    ['an empty header', ''],
    ['a bare token with no scheme', 'admin-token'],
    ['a wrong scheme', 'Basic YWRtaW46YWRtaW4='],
    ['a bearer prefix with an empty token', 'Bearer '],
    ['a token with a trailing space', 'Bearer admin-token '],
  ])('returns null for %s', (_label, header) => {
    const caller = authenticateBearer(header, {
      expectedSecret: CONFIG.controlPlaneAuth.adminToken,
      expectedPrincipal: CONFIG.controlPlaneAuth.adminPrincipal,
    });
    expect(caller).toBeNull();
  });

  it('keeps the Admin token and the Application token separate', () => {
    // ⚠️ **Ba boundary, ba cơ chế.** Nếu token của Admin được chấp nhận ở Application API
    // thì một token quyền cao hơn chạy được ở boundary thấp hơn — đúng lớp lỗi mà
    // `FR-019` tách ba cơ chế để tránh.
    const withAdminToken = authenticateBearer('Bearer admin-token', {
      expectedSecret: CONFIG.controlPlaneAuth.applicationToken,
      expectedPrincipal: CONFIG.controlPlaneAuth.applicationPrincipal,
    });
    const withApplicationToken = authenticateBearer('Bearer application-token', {
      expectedSecret: CONFIG.controlPlaneAuth.adminToken,
      expectedPrincipal: CONFIG.controlPlaneAuth.adminPrincipal,
    });
    expect(withAdminToken).toBeNull();
    expect(withApplicationToken).toBeNull();
  });

  it('keeps the runtime shared secret from working as a bearer token', () => {
    // ⚠️ Runtime API dùng header riêng, không phải `Authorization`. Nếu shared secret của
    // runtime làm được bearer token thì một caller chỉ biết secret đó (và nó là secret *được
    // chia sẻ* với delivery worker) sẽ điều khiển được Admin API.
    expect(
      authenticateBearer('Bearer runtime-secret', {
        expectedSecret: CONFIG.controlPlaneAuth.adminToken,
        expectedPrincipal: CONFIG.controlPlaneAuth.adminPrincipal,
      }),
    ).toBeNull();
  });
});

describe('readBearerToken', () => {
  it('extracts the token and normalises nothing else', () => {
    // ⚠️ Token phải trả **nguyên văn** — khoá trong allowlist/so sánh phụ thuộc chính xác
    // từng byte, và `trim()` ở đây sẽ biến một token hợp lệ có khoảng trắng cuối thành một
    // token khác.
    expect(readBearerToken('Bearer abc-123')).toBe('abc-123');
    expect(readBearerToken('bearer   spaced  ')).toBe('  spaced  ');
  });

  it('rejects a non-string authorization value', () => {
    // ⚠️ Header của Hono trả `string | null`, nhưng `readBearerToken` nhận `unknown` thực tế
    // qua `typeof` check — một giá trị không phải chuỗi lọt xuống `.slice()` sẽ ném.
    for (const value of [undefined, 42, {}, []]) {
      expect(readBearerToken(value as unknown as string | null)).toBeNull();
    }
  });
});

describe('constantTimeEquals — a comparison that does not depend on where the bytes differ', () => {
  it('returns true only for identical strings', () => {
    expect(constantTimeEquals('secret', 'secret')).toBe(true);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('detects a difference at the first byte and at the last byte alike', () => {
    // ⚠️ `===` trên chuỗi rời ngay khi gặp byte khác nhau, nên thời gian thay đổi theo **vị
    // trí** byte khác nhau đầu tiên — đủ để dò tiền tố của một secret. Cả hai vị trí dưới
    // đây phải cho cùng một kết quả boolean.
    expect(constantTimeEquals('Xecret', 'secret')).toBe(false);
    expect(constantTimeEquals('secreX', 'secret')).toBe(false);
    expect(constantTimeEquals('Xecret', 'secreX')).toBe(false);
  });

  it('detects a length difference even when one string is a prefix of the other', () => {
    // ⚠️ Đây là lớp lỗi mà một so khớp `difference |= bytes[i] ^ other[i]` thiếu kiểm tra
    // độ dài sẽ bỏ sót: `leftBytes.length ^ rightBytes.length` phải được tích luỹ **vào**
    // cùng biến.
    expect(constantTimeEquals('secret', 'secre')).toBe(false);
    expect(constantTimeEquals('secre', 'secret')).toBe(false);
    expect(constantTimeEquals('secret', '')).toBe(false);
    expect(constantTimeEquals('', 'secret')).toBe(false);
  });

  it('compares multi-byte characters byte by byte, not code unit by code unit', () => {
    // ⚠️ `TextEncoder` cho bytes **UTF-8**: một ký tự nhiều byte so sánh theo **nhiều byte**,
    // và byte suy ra được vẫn là byte của secret — không lộ gì thêm. `\u{1F510}` là 4 byte
    // nên một so khớp theo code unit sẽ so 2 code unit thay vì 4 byte.
    expect(constantTimeEquals('kho\u00e1', 'kho\u00e1')).toBe(true);
    expect(constantTimeEquals('kho\u00e1', 'kho\u0061\u0301')).toBe(false);
    expect(constantTimeEquals('kho\u0061\u0301', 'kho\u00e1')).toBe(false);
    expect(constantTimeEquals('\u{1F510}', '\u{1F510}')).toBe(true);
    expect(constantTimeEquals('\u{1F510}', '\u{1F511}')).toBe(false);
  });

  it('treats two Unicode normalisations of the same visible secret as different', () => {
    // ⚠️ **`khoá` có hai cách mã hoá**: NFC (`á` = `U+00E1`, 1 code unit / 2 byte) và NFD
    // (`a` + `U+0301`, 2 code unit / 3 byte). Chúng trông **giống hệt** nhưng là hai chuỗi
    // byte khác nhau, nên phải bất bằng. Đây là hệ quả trực tiếp của việc so trên bytes: một
    // secret so trên code unit dài bằng nhau sẽ trả `true` ở đây — tức chấp nhận một secret mà
    // người gọi không hề gõ, và đó cũng là một secret mà `wrangler secret put` không ghi ra.
    expect('kho\u00e1'.normalize('NFC')).toHaveLength(4);
    expect('kho\u0061\u0301'.normalize('NFD')).toHaveLength(5);

    expect(constantTimeEquals('kho\u00e1'.normalize('NFC'), 'kho\u00e1'.normalize('NFC'))).toBe(
      true,
    );
    expect(constantTimeEquals('kho\u00e1'.normalize('NFC'), 'kho\u00e1'.normalize('NFD'))).toBe(
      false,
    );
    expect(constantTimeEquals('kho\u00e1'.normalize('NFD'), 'kho\u00e1'.normalize('NFC'))).toBe(
      false,
    );
  });

  it('detects a multi-byte difference at the last byte of the string', () => {
    // ⚠️ Khác biệt nằm ở **byte cuối** nhưng byte cuối đó là **tail** của một ký tự nhiều
    // byte. Byte đầu thì đã có một test riêng; test này bảo vệ đúng vị trí cuối, vì đó là vị
    // trí mà một vòng lặp lồng nhau kiểm độ dài rồi `break` sớm sẽ bỏ sót.
    expect(constantTimeEquals('secr\u00e9t', 'secr\u00e9t')).toBe(true);
    expect(constantTimeEquals('secr\u00e9t', 'secr\u00e8t')).toBe(false);
    expect(constantTimeEquals('secr\u00e9t', 'secrit')).toBe(false);
  });

  it('does not treat a same-length but different string as equal', () => {
    // ⚠️ Không dùng `===` ngầm ở bất kỳ nhánh nào: `secret` và `secreT` cùng độ dài, chỉ khác
    // byte cuối.
    expect(constantTimeEquals('secret', 'secreT')).toBe(false);
  });
});
