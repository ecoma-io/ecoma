import { expect, test } from '@playwright/test';

import { resolveAccountOrigin, stackRequest } from './support/local-origin';

/**
 * Negative paths của `verify` — mọi thất bại của luồng là CÙNG MỘT 400: không
 * phân biệt "chưa từng yêu cầu mã", "mã hết hạn", "mã sai", "hết lượt thử",
 * "mã đã dùng" (header comment của `verify.post.ts` §Thông điệp lỗi chung
 * chung). Phân biệt là oracle cho attacker đang đoán mã.
 *
 * Trên wire, 400 là JSON `h3` chuẩn (`{error, url, statusCode, statusMessage,
 * message}` với `statusMessage: 'Bad Request'`) — ĐÃ XÁC MINH trên stack thật.
 * Suite assert `statusCode` + `message` giống nhau giữa các nhánh (bề mặt
 * ổn định), KHÔNG assert khớp chuỗi h3-internal nào khác (url đổi theo origin
 * — origin là host:port động).
 *
 * File này KHÔNG seed user và KHÔNG challenge: mọi nhánh dưới đều là nhánh từ
 * chối của `verify` trước khi cần biết user tồn tại — địa chỉ test là địa chỉ
 * "ma" (không seed) nên không đụng cửa sổ rate-limit hay cooldown của file
 * nào khác, và không tiêu attempts của challenge nào.
 */

test.describe('verify negative paths', () => {
  let origin: string;

  test.beforeAll(() => {
    origin = resolveAccountOrigin();
  });

  test.describe.configure({ mode: 'serial' });

  let firstRejectBody: unknown;

  test('verify with a wrong code without any active challenge rejects with 400', async () => {
    const response = await stackRequest(`${origin}/api/auth/verify`, {
      method: 'POST',
      bodyText: JSON.stringify({ email: 'identity-login-e2e-neg@local.test', code: '00000000' }),
    });
    expect(response.status).toBe(400);
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    expect(payload['statusCode']).toBe(400);
    expect(payload['message']).toBe('Bad Request');
    // Lưu bề mặt để test kế so — mọi nhánh từ chối phải GIỐNG NHAU byte-đáng
    // kể (trừ `url` vốn chứa origin động).
    firstRejectBody = payload;
  });

  test('verify for an address that never challenged rejects indistinguishably', async () => {
    const response = await stackRequest(`${origin}/api/auth/verify`, {
      method: 'POST',
      bodyText: JSON.stringify({ email: 'identity-login-e2e-never@local.test', code: '11111111' }),
    });
    expect(response.status).toBe(400);
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    const { url: _url, ...surfaceOfThis } = payload;
    const { url: _urlFirst, ...surfaceOfFirst } = firstRejectBody as Record<string, unknown>;
    // "Chưa từng challenge" và "mã sai" là CÙNG MỘT response ngoài `url`.
    expect(surfaceOfThis).toEqual(surfaceOfFirst);
  });

  test('verify with a malformed body rejects with 400 too', async () => {
    // `code` không phải 8 digit → isVerifyBody sai → nhánh `Bad Request` của
    // body-sai-hình dạng. Cũng 400 — người gọi tự sửa được, không lộ gì.
    const response = await stackRequest(`${origin}/api/auth/verify`, {
      method: 'POST',
      bodyText: JSON.stringify({ email: 'identity-login-e2e-neg@local.test', code: '12' }),
    });
    expect(response.status).toBe(400);
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    expect(payload['statusCode']).toBe(400);
    expect(payload['message']).toBe('Bad Request');
  });

  test('verify with a wrong 8-digit code on an unknown address keeps no oracle', async () => {
    // Kết hợp hai chiều: địa chỉ lạ + mã "có thể đúng" — vẫn 400 cùng bề mặt.
    const response = await stackRequest(`${origin}/api/auth/verify`, {
      method: 'POST',
      bodyText: JSON.stringify({
        email: 'identity-login-e2e-unknown@local.test',
        code: '12345678',
      }),
    });
    expect(response.status).toBe(400);
    const payload = JSON.parse(response.body) as Record<string, unknown>;
    const { url: _url, ...surfaceOfThis } = payload;
    const { url: _urlFirst, ...surfaceOfFirst } = firstRejectBody as Record<string, unknown>;
    expect(surfaceOfThis).toEqual(surfaceOfFirst);
  });
});
