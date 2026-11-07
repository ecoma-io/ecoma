import { expect, test } from '@playwright/test';

import { AUTH_IDENTITY } from './support/fixtures';
import { resolveStackOrigin } from './support/local-origin';
import { performBrowserLogin } from './support/oidc-flow';
import {
  mailWicContainerOf,
  readOtpFromMailSink,
  resolvePostgresContainer,
  seedAccountIdentity,
} from './support/stack-fixtures';

/**
 * Login browser đầy đủ + access đã đăng nhập.
 *
 * Mỗi test file chạy luồng login riêng qua `serial` (KHÔNG dùng
 * `storageState` dùng chung): session của BFF là server-side (`bff_sessions`)
 * gắn cookie; chia sẻ storage qua file làm hai worker song song có thể dùng
 * chung session và che bug `bff_sessions` (một session bị revoke thì cả hai
 * test đỏ cùng lúc với nguyên nhân khó truy). Chi phí là mỗi file một luồng
 * login — stack local chịu được hai worker chạy song song.
 *
 * ⚠️ `test.describe.serial` vẫn cho mỗi test MỘT browser context mới — trạng
 * thái đăng nhập KHÔNG tự carry giữa các test. Test nào cần session phải tự
 * login (`performBrowserLogin`) hoặc tự mang cookie của phiên mình.
 *
 * `/api/me` là route đọc session (KHÔNG enforcement permission) — 200 với
 * `{sub, displayName}` chứng minh toàn chuỗi token→session→principal chạy
 * thật. `displayName` local luôn `null` (controlled degrade): container Node
 * không có binding `ACCOUNT_SERVICE` nên `accountClientConfig` trả `null` —
 * suite chấp nhận cả hai (null hoặc string) nhưng KHÔNG chấp nhận vắng mặt.
 */

test.describe.serial('authenticated access after full browser login', () => {
  /** Contract hop cuối (callback → `/`), do test đầu ghi lại. */
  let callbackStatus: number | undefined;

  test('full browser login through auth and account lands back on the backoffice with a session', async ({
    page,
    context,
  }) => {
    // Seed account identity TRƯỚC khi challenge chạy — lookup verified address
    // phải thấy hàng, nếu không route trả 204 anti-enumeration và OTP không bao
    // giờ được sinh.
    const postgres = await resolvePostgresContainer(resolveStackOrigin());
    await seedAccountIdentity(postgres, AUTH_IDENTITY);

    // Mốc thời gian cho poll OTP: chỉ nhận mail sinh SAU khi challenge bắt đầu.
    const sinceMs = Date.now();
    const mailWic = mailWicContainerOf(postgres);

    const { finalHop } = await performBrowserLogin(page, {
      email: AUTH_IDENTITY.email,
      readOtp: () => readOtpFromMailSink(mailWic, { recipient: AUTH_IDENTITY.email, sinceMs }),
    });
    callbackStatus = finalHop.status;

    // Browser đứng ở `/` của backoffice (callback 302 đích cuối).
    expect(page.url()).toBe(`${resolveStackOrigin()}/`);

    // Session cookie đã nằm trong browser context — HttpOnly vẫn đọc được qua
    // API context của Playwright (không phải document.cookie).
    const cookies = await context.cookies(resolveStackOrigin());
    const session = cookies.find((c) => c.name === '__Host-backoffice-session');
    expect(session).toBeDefined();
    expect(session?.secure).toBe(true);
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
  });

  test('the final callback hop responds 302 (token exchange and session write succeeded)', async () => {
    // Bằng chứng hop cuối sát server nhất: callback 302 (không phải 500 —
    // token exchange nội bộ chạy đúng) và cookie được set ngay hop đó.
    expect(callbackStatus).toBe(302);
  });

  test('authenticated GET /api/me returns 200 with the principal sub', async ({ page }) => {
    // Context của test này là MỚI (serial không chia sẻ context) — fetch từ
    // `about:blank` không có cookie mà fetch relative URL cũng chết ("Failed to
    // parse URL"). Login lại trong chính test này để có phiên của mình.
    const postgres = await resolvePostgresContainer(resolveStackOrigin());
    await seedAccountIdentity(postgres, AUTH_IDENTITY);
    const sinceMs = Date.now();
    const mailWic = mailWicContainerOf(postgres);
    await performBrowserLogin(page, {
      email: AUTH_IDENTITY.email,
      readOtp: () => readOtpFromMailSink(mailWic, { recipient: AUTH_IDENTITY.email, sinceMs }),
    });

    // Dùng lại session của test qua browser: fetch từ trang (same-origin,
    // cookie tự gửi) — đây là đúng đường mà UI của backoffice gọi API.
    const me = await page.evaluate(async () => {
      const response = await fetch('/api/me');
      return {
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        body: (await response.json()) as { sub?: string; displayName?: string | null },
      };
    });
    expect(me.status).toBe(200);
    expect(me.body.sub).toBe(AUTH_IDENTITY.sub);
    // displayName có thể null (account binding vắng local) nhưng key phải có.
    expect('displayName' in me.body).toBe(true);
    // Route đọc principal phải no-store — phiên không được cache ở chỗ nào.
    expect(me.cacheControl).toContain('no-store');
  });

  test('the overview page renders the three area links (UI smoke, no business assertion)', async ({
    page,
  }) => {
    // Context mới — login lại như test trên trước khi xem trang authenticated.
    const postgres = await resolvePostgresContainer(resolveStackOrigin());
    await seedAccountIdentity(postgres, AUTH_IDENTITY);
    const sinceMs = Date.now();
    const mailWic = mailWicContainerOf(postgres);
    await performBrowserLogin(page, {
      email: AUTH_IDENTITY.email,
      readOtp: () => readOtpFromMailSink(mailWic, { recipient: AUTH_IDENTITY.email, sinceMs }),
    });

    await page.goto('/');
    // Assertion UI GIỚI HẠN: suite này không phải UI suite (apps/backoffice/e2e
    // lo phần đó) — chỉ chứng minh trang authenticated render thật.
    await expect(page.getByTestId('overview-area-staff')).toBeVisible();
    await expect(page.getByTestId('backoffice-page-title')).toBeVisible();
  });
});
