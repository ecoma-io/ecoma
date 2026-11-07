/**
 * Test của authorization boundary của `POST /internal/reconcile/jobs`.
 *
 * ⚠️ Suite này khẳng định **một câu trả lời duy nhất**. Phân biệt "thiếu header" với "sai
 * secret" là một oracle đo lời gọi đã thử gì, và đó là lý do mọi ca từ chối đều cùng `401`.
 * Do đó không có test nào ở đây được phép khẳng định *tại sao* một request bị từ chối — chỉ
 * khẳng định rằng nó bị từ chối, và rằng cùng một lý do cho ra cùng một câu trả lời.
 */

import { describe, expect, it } from 'vitest';

import {
  RECONCILE_PRINCIPAL_HEADER,
  RECONCILE_SHARED_SECRET_HEADER,
  WEB_PUSH_JOB_PRINCIPAL,
  authenticateReconciliationCaller,
  constantTimeEquals,
  readRequestHeader,
  type HeadersLike,
} from './reconciliation-auth';

const SECRET = 'shared-secret-of-the-reconciliation-endpoint';
const PRINCIPAL = WEB_PUSH_JOB_PRINCIPAL;

/**
 * Header tối thiểu — chỉ `get`, đúng phần `HeadersLike` cần.
 *
 * ⚠️ Dựng map bằng `Object.keys` + `for…of`, không dùng `Object.entries`: tầng application
 * build với `lib: ["es2022"]` + `types: []` (xem `reconciliation-auth.ts`), nên
 * `Object.entries` là `TS2550`. Đây là cùng ràng buộc mà chính file đó đã phải tránh với
 * `Headers` — spec không được phá vỡ nó bằng một global Web API khác.
 */
function headersOf(entries: Record<string, string>): HeadersLike {
  const map = new Map<string, string>();
  for (const name of Object.keys(entries)) {
    map.set(name.toLowerCase(), entries[name] ?? '');
  }
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

function call(entries: Record<string, string>) {
  return authenticateReconciliationCaller(readRequestHeader(headersOf(entries)), {
    sharedSecret: SECRET,
    expectedPrincipal: PRINCIPAL,
  });
}

const VALID = {
  [RECONCILE_SHARED_SECRET_HEADER]: SECRET,
  [RECONCILE_PRINCIPAL_HEADER]: PRINCIPAL,
};

/* -------------------------------------------------------------------------------------- */
/* Happy path                                                                                 */
/* -------------------------------------------------------------------------------------- */

describe('authenticateReconciliationCaller accepts a correct caller', () => {
  it('returns the expected principal for the valid header pair', () => {
    expect(call(VALID)).toEqual({ principal: PRINCIPAL });
  });

  // Giá trị nguyên văn, không có scheme `Bearer` — cùng chính sách với private API của
  // control plane. Một worker gửi `Bearer …` sẽ không khớp, và đó là hành vi mong muốn.
  it('takes the secret verbatim, with no Bearer scheme', () => {
    expect(call({ ...VALID, [RECONCILE_SHARED_SECRET_HEADER]: `Bearer ${SECRET}` })).toBeNull();
  });

  it('reads headers case-insensitively, as HTTP requires', () => {
    expect(call({ Authorization: SECRET, 'X-Ecoma-Principal': PRINCIPAL })).toEqual({
      principal: PRINCIPAL,
    });
  });
});

/* -------------------------------------------------------------------------------------- */
/* Từ chối                                                                                    */
/* -------------------------------------------------------------------------------------- */

describe('authenticateReconciliationCaller rejects everything else with one answer', () => {
  it.each([
    ['no headers at all', {}],
    ['only the secret', { [RECONCILE_SHARED_SECRET_HEADER]: SECRET }],
    ['only the principal', { [RECONCILE_PRINCIPAL_HEADER]: PRINCIPAL }],
    ['an empty secret', { ...VALID, [RECONCILE_SHARED_SECRET_HEADER]: '' }],
    ['an empty principal', { ...VALID, [RECONCILE_PRINCIPAL_HEADER]: '' }],
    ['a wrong secret', { ...VALID, [RECONCILE_SHARED_SECRET_HEADER]: `${SECRET}-khac` }],
    [
      'a secret that is a prefix of the real one',
      { ...VALID, [RECONCILE_SHARED_SECRET_HEADER]: SECRET.slice(0, -1) },
    ],
    [
      'a secret with trailing whitespace',
      { ...VALID, [RECONCILE_SHARED_SECRET_HEADER]: `${SECRET} ` },
    ],
    ['a wrong principal', { ...VALID, [RECONCILE_PRINCIPAL_HEADER]: 'svc.khác' }],
    ['an empty-string principal that is falsy', { ...VALID, [RECONCILE_PRINCIPAL_HEADER]: '0' }],
    [
      'a principal of a control-plane service',
      { ...VALID, [RECONCILE_PRINCIPAL_HEADER]: 'svc.push-notification' },
    ],
  ])('returns null for %s', (_name, headers) => {
    expect(call(headers)).toBeNull();
  });

  // ⚠️ Đây là invariant quan trọng nhất của boundary: **mọi** ca từ chối phải cho ra **cùng**
  // một câu trả lời. Test này gom tất cả từ chối vào một mảng và so bằng phép bình phương
  // của độ dài, nên thêm một ca từ chối mới có "chi tiết hơn" sẽ làm nó đỏ.
  it('gives an identical answer for every kind of rejection', () => {
    // ⚠️ Khai báo kiểu ở **phần tử**, không phải ở `map`: một union các object literal có
    // `undefined` tường minh sẽ không tương thích với `Record<string, string>`, và ép kiểu ở
    // tham số `map` chỉ che lỗi đó chứ không sửa. `Record<string, string>` ở đây là đúng —
    // `headersOf` nhận đúng tập header đã chuẩn hoá.
    const rejections: readonly Record<string, string>[] = [
      {},
      { [RECONCILE_SHARED_SECRET_HEADER]: SECRET },
      { [RECONCILE_SHARED_SECRET_HEADER]: '', [RECONCILE_PRINCIPAL_HEADER]: PRINCIPAL },
      { ...VALID, [RECONCILE_SHARED_SECRET_HEADER]: 'wrong' },
      { ...VALID, [RECONCILE_PRINCIPAL_HEADER]: 'wrong' },
    ];
    const answers = rejections.map((headers) => call(headers));

    for (const answer of answers) {
      expect(answer).toBeNull();
    }
  });

  // Fail-closed ở tầng resolve: secret rỗng phải bị từ chối, không được coi là "không cần
  // xác thực". Cấu hình hỏng không bao giờ là một cách để mở cửa.
  //
  // ⚠️ Ca nguy hiểm nhất là **cả hai** rỗng: header mang `''`, config mang `''`. Khi đó
  // `constantTimeEquals('', '')` trả `true`, và một boundary so sánh bằng phép bình phương
  // sẽ mở toạch chỉ vì cấu hình hỏng. Test này ghim đúng ca đó.
  it.each([
    [
      'an empty secret in config',
      { sharedSecret: '', expectedPrincipal: PRINCIPAL },
      SECRET,
      PRINCIPAL,
    ],
    ['an empty principal in config', { sharedSecret: SECRET, expectedPrincipal: '' }, SECRET, ''],
    [
      'both empty in config and in the request',
      { sharedSecret: '', expectedPrincipal: '' },
      '',
      '',
    ],
    [
      'both empty in config, non-empty request',
      { sharedSecret: '', expectedPrincipal: '' },
      SECRET,
      PRINCIPAL,
    ],
  ])('rejects %s', (_name, config, providedSecret, providedPrincipal) => {
    const result = authenticateReconciliationCaller(
      readRequestHeader(
        headersOf({
          [RECONCILE_SHARED_SECRET_HEADER]: providedSecret,
          [RECONCILE_PRINCIPAL_HEADER]: providedPrincipal,
        }),
      ),
      config,
    );
    expect(result).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------- */
/* So sánh constant-time                                                                      */
/* -------------------------------------------------------------------------------------- */

describe('constantTimeEquals', () => {
  it.each([
    ['identical strings', SECRET, SECRET, true],
    ['two empty strings', '', '', true],
    ['a one-character difference', SECRET, `${SECRET}x`, false],
    ['a differing first character', SECRET, `X${SECRET.slice(1)}`, false],
    ['a left string that is a prefix', 'abc', 'abcd', false],
    ['a right string that is a prefix', 'abcd', 'abc', false],
    ['completely different', 'abc', 'xyz', false],
  ])('returns the right verdict for %s', (_name, left, right, expected) => {
    expect(constantTimeEquals(left, right)).toBe(expected);
  });

  // So sánh byte UTF-8 chứ không so ký tự: hai chuỗi có cùng số ký tự nhưng khác số byte phải
  // cho kết quả khác, và byte `0` bên trong chuỗi phải được tính (không phải chuỗi kết thúc).
  it('compares UTF-8 bytes rather than JavaScript code units', () => {
    expect(constantTimeEquals('é', 'e')).toBe(false);
    expect(constantTimeEquals('é', 'é')).toBe(true);
    // U+1F600 (4 byte) vs U+FFFD (3 byte): cùng một "ký tự" theo pairing, khác theo byte.
    expect(constantTimeEquals('\u{1f600}', '�')).toBe(false);
  });

  it('handles a lone surrogate without crashing the comparison', () => {
    expect(() => constantTimeEquals('\ud800', SECRET)).not.toThrow();
    expect(constantTimeEquals('\ud800', '\ud800')).toBe(true);
    expect(constantTimeEquals('\ud800', '\ud801')).toBe(false);
  });

  // ⚠️ Thuật toán phải XOR cả **phần chênh độ dài**, không chỉ vòng lặp trên chiều dài chung —
  // nếu không, một secret ngắn lộ qua số vòng lặp.
  it('does not leak length through a shorter-side early exit', () => {
    expect(constantTimeEquals('a', 'a'.repeat(1_000))).toBe(false);
    expect(constantTimeEquals('a'.repeat(1_000), 'a')).toBe(false);
    expect(constantTimeEquals('a'.repeat(1_000), `${'a'.repeat(999)}b`)).toBe(false);
  });

  it('is symmetric', () => {
    expect(constantTimeEquals('abc', 'abd')).toBe(constantTimeEquals('abd', 'abc'));
  });
});

/* -------------------------------------------------------------------------------------- */
/* Header reader                                                                              */
/* -------------------------------------------------------------------------------------- */

describe('readRequestHeader', () => {
  it('returns null for an absent header instead of undefined', () => {
    expect(readRequestHeader(headersOf({}))('authorization')).toBeNull();
  });

  it('passes the name straight through, so the caller controls case', () => {
    const seen: string[] = [];
    const read = readRequestHeader({
      get: (name) => {
        seen.push(name);
        return null;
      },
    });
    read('X-Whatever');

    expect(seen).toEqual(['X-Whatever']);
  });
});
