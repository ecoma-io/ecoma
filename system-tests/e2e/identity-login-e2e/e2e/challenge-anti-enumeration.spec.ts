import { expect, test } from '@playwright/test';

import { resolveAccountOrigin, stackRequest } from './support/local-origin';
import {
  cleanupFixtureData,
  resolveStackNamespace,
  seedFixtureUser,
  type FixtureIdentity,
} from './support/local-stack';

/**
 * Anti-enumeration — bất biến số một của `challenge` (header comment của
 * `apps/account/server/api/auth/challenge.post.ts`):
 *
 * Mọi request với `email` hợp lệ về hình dạng nhận CÙNG MỘT response — `204`,
 * không body — dù địa chỉ tồn tại và verified, tồn tại nhưng pending, không
 * tồn tại, thuộc account suspended/deleted, hay vừa bị rate-limit. Mọi nhánh
 * bị chặn (cooldown 60s, rate-limit 3/15 phút) cũng 204 im lặng.
 *
 * Suite KHÔNG assert timing: route cố giảm khác biệt thời gian (vẫn ghi
 * challenge cho địa chỉ lạ), nhưng timing qua một stack local nhiều tầng là
 * nhiễu — header comment ghi rõ timing "trong giới hạn của một lần ghi DB",
 * không phải contract assert-được từ outside. Cả hai nhánh dưới đều VẪN ghi
 * hàng `otp_challenges` (ma hay thật) — cleanup sau suite xóa theo hash của
 * cả hai địa chỉ (`extraEmails`).
 *
 * File này dùng danh tính fixture RIÊNG (xem `FixtureIdentity`) và chỉ
 * challenge HAI lần — không đụng cửa sổ rate-limit của file nào khác.
 */

/** Danh tính fixture RIÊNG của file này — không file nào khác dùng chung. */
const FIXTURE: FixtureIdentity = {
  sub: 'identity-login-e2e-enum-user',
  email: 'identity-login-e2e-enum@local.test',
};
/** Địa chỉ "ma" — không seed, không tồn tại; cleanup xóa challenge của nó. */
const GHOST_EMAIL = 'identity-login-e2e-enum-unknown@local.test';

test.describe('challenge anti-enumeration surface', () => {
  let origin: string;
  let namespace: string;

  test.beforeAll(() => {
    origin = resolveAccountOrigin();
    namespace = resolveStackNamespace();
    // Seed chỉ để bảo đảm nhánh "known verified" là thật sự known — test so
    // response của known và unknown, không phụ thuộc thứ tự chạy file.
    seedFixtureUser(namespace, FIXTURE);
  });

  test.afterAll(() => {
    cleanupFixtureData(namespace, FIXTURE, [GHOST_EMAIL]);
  });

  test('challenge with a verified address returns bare 204', async () => {
    const response = await stackRequest(`${origin}/api/auth/challenge`, {
      method: 'POST',
      bodyText: JSON.stringify({ email: FIXTURE.email }),
    });
    expect(response.status).toBe(204);
    expect(response.body).toBe('');
    expect(response.rawSetCookie).toEqual([]);
  });

  test('challenge with an unknown address returns the same bare 204', async () => {
    const response = await stackRequest(`${origin}/api/auth/challenge`, {
      method: 'POST',
      bodyText: JSON.stringify({ email: GHOST_EMAIL }),
    });
    // Cùng status, cùng "không body", cùng "không cookie" — KHÔNG có byte nào
    // phân biệt được hai nhánh. Đây là toàn bộ bề mặt mà kẻ dò nhìn thấy.
    expect(response.status).toBe(204);
    expect(response.body).toBe('');
    expect(response.rawSetCookie).toEqual([]);
  });
});
