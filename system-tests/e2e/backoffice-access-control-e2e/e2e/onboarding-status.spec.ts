import { expect, test } from '@playwright/test';

import {
  ONBOARDING_NAMED_DISPLAY_NAME,
  ONBOARDING_NAMED_IDENTITY,
  ONBOARDING_UNNAMED_IDENTITY,
} from './support/fixtures';
import { resolveStackOrigin, stackGet } from './support/local-origin';
import { performBrowserLogin } from './support/oidc-flow';
import {
  clearAccountDisplayName,
  mailWicContainerOf,
  readOtpFromMailSink,
  resolvePostgresContainer,
  seedAccountDisplayName,
  seedAccountIdentity,
} from './support/stack-fixtures';

/**
 * Onboarding status + display name của backoffice trên lane local thật
 * (issue #242).
 *
 * Điều kiện hoàn thành của #242, viết thành assert quan sát được:
 *
 * 1. `GET /api/onboarding-status` trả **200** với `needsDisplayName` đúng —
 *    không phải 503 `account_client_unconfigured` (trạng thái trước #242:
 *    container Node local không có binding `ACCOUNT_SERVICE`).
 * 2. `GET /api/me` trả `displayName` **khác null** cho user đã có tên, và
 *    `null` (không 5xx) cho user chưa có tên.
 * 3. Nhánh onboarding của callback: user CHƯA có tên ⇒ đích `/onboarding`;
 *    user ĐÃ có tên ⇒ đích `/`.
 *
 * Cả hai nhánh đều đi qua login browser thật (OTP từ mail sink D1) trên stack
 * local thật — không mock, không stub.
 *
 * ⚠️ Mỗi identity dùng MỘT email riêng: hai worker chạy song song cùng đi
 * path `granted` (grant persist qua các run) và cùng poll một hộp thư sink —
 * email chung ⇒ cross-match OTP giữa hai file.
 */

/** Đọc `/api/me` + `/api/onboarding-status` bằng cookie phiên của browser. */
async function readIdentityApis(
  page: import('@playwright/test').Page,
  context: import('@playwright/test').BrowserContext,
): Promise<{
  meStatus: number;
  meBody: { sub?: string; displayName?: string | null };
  onboardingStatus: number;
  onboardingBody: { needsDisplayName?: boolean };
}> {
  const cookies = await context.cookies(resolveStackOrigin());
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await stackGet(`${resolveStackOrigin()}/api/me`, { cookie: header });
  const onboarding = await stackGet(`${resolveStackOrigin()}/api/onboarding-status`, {
    cookie: header,
  });
  return {
    meStatus: me.status,
    meBody: JSON.parse(me.body || '{}') as { sub?: string; displayName?: string | null },
    onboardingStatus: onboarding.status,
    onboardingBody: JSON.parse(onboarding.body || '{}') as { needsDisplayName?: boolean },
  };
}

test.describe.serial('onboarding status and display name resolve from account', () => {
  test('a user without a display name lands on /onboarding and needsDisplayName is true', async ({
    page,
    context,
  }) => {
    const postgres = await resolvePostgresContainer(resolveStackOrigin());
    await seedAccountIdentity(postgres, ONBOARDING_UNNAMED_IDENTITY);
    // Xoá profile nếu một lần chạy trước đã tạo ⇒ "chưa có tên" là trạng
    // thái thật của lần chạy này, không phải phần dư của lần trước.
    await clearAccountDisplayName(postgres, { sub: ONBOARDING_UNNAMED_IDENTITY.sub });

    const sinceMs = Date.now();
    const mailWic = mailWicContainerOf(postgres);
    const { finalHop, finalPath } = await performBrowserLogin(page, {
      email: ONBOARDING_UNNAMED_IDENTITY.email,
      readOtp: () =>
        readOtpFromMailSink(mailWic, { recipient: ONBOARDING_UNNAMED_IDENTITY.email, sinceMs }),
    });

    // Callback 302 — token exchange + session write thành công.
    expect(finalHop.status).toBe(302);
    // Nhánh onboarding của callback ĐÃ chạy (trước #242 nhánh này không bao
    // giờ chạy trên lane local vì account không trả lời được).
    expect(finalPath).toBe('/onboarding');

    const api = await readIdentityApis(page, context);
    expect(api.onboardingStatus).toBe(200);
    expect(api.onboardingBody.needsDisplayName).toBe(true);
    expect(api.meStatus).toBe(200);
    expect(api.meBody.sub).toBe(ONBOARDING_UNNAMED_IDENTITY.sub);
    // Chưa có tên ⇒ `null` (giá trị thật của contract), KHÔNG phải 5xx.
    expect(api.meBody.displayName).toBeNull();
  });

  test('a user with a display name lands on / and needsDisplayName is false', async ({
    page,
    context,
  }) => {
    const postgres = await resolvePostgresContainer(resolveStackOrigin());
    await seedAccountIdentity(postgres, ONBOARDING_NAMED_IDENTITY);
    await seedAccountDisplayName(postgres, {
      sub: ONBOARDING_NAMED_IDENTITY.sub,
      displayName: ONBOARDING_NAMED_DISPLAY_NAME,
    });

    const sinceMs = Date.now();
    const mailWic = mailWicContainerOf(postgres);
    const { finalHop, finalPath } = await performBrowserLogin(page, {
      email: ONBOARDING_NAMED_IDENTITY.email,
      readOtp: () =>
        readOtpFromMailSink(mailWic, { recipient: ONBOARDING_NAMED_IDENTITY.email, sinceMs }),
    });

    expect(finalHop.status).toBe(302);
    // Đã có tên ⇒ đi thẳng app, KHÔNG qua màn onboarding.
    expect(finalPath).toBe('/');

    const api = await readIdentityApis(page, context);
    expect(api.onboardingStatus).toBe(200);
    expect(api.onboardingBody.needsDisplayName).toBe(false);
    expect(api.meStatus).toBe(200);
    expect(api.meBody.sub).toBe(ONBOARDING_NAMED_IDENTITY.sub);
    // `displayName` resolve ĐƯỢC từ account — không còn `null` do degrade.
    expect(api.meBody.displayName).toBe(ONBOARDING_NAMED_DISPLAY_NAME);
  });
});
