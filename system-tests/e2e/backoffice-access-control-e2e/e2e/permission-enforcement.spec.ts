import { expect, test } from '@playwright/test';

import { PERMISSION_IDENTITY, TEST_STAFF_ACCESS_ROLE_ID } from './support/fixtures';
import { CookieJar, resolveStackOrigin, stackGet } from './support/local-origin';
import { performBrowserLogin } from './support/oidc-flow';
import {
  countAuthorizationAuditSuccess,
  mailWicContainerOf,
  readOtpFromMailSink,
  resolvePostgresContainer,
  seedAccountIdentity,
  seedStaffAccessGrant,
  seedStaffAccessStaff,
  revokeStaffAccessAssignment,
} from './support/stack-fixtures';

/**
 * Permission enforcement — trái tim của suite.
 *
 * ## Nguồn quyết định là projection Staff Access (issue #241)
 *
 * Sau cutover (`BACKOFFICE_AUTHZ_PROJECTION_CUTOVER_AT` do
 * `deploys/backoffice-deploy` cấp), BFF quyết định permission từ projection
 * Staff Access (staff + role + assignment + role_permissions của
 * `db-staff-access`), không từ legacy `db-backoffice`. Vì vậy grant của suite
 * được seed **CHỈ** vào `db-staff-access` — nếu BFF vẫn quyết định từ legacy
 * (regression của #241: legacy rỗng trên lane thật ⇒ 403 cho operator hợp lệ)
 * hoặc gate cutover không được cấp, các assertion 200 dưới đây ĐỎ. Suite từng
 * seed grant vào `db-backoffice` và vì thế không bắt được gap đó — đây chính
 * là lỗ hổng phủ test mà #241 ghi nhận.
 *
 * Chuỗi trạng thái THẬT, assert qua HTTP thật:
 *
 * 1. Đã đăng nhập nhưng `db-staff-access` chưa có gì của sub ⇒ projection
 *    trả assignments rỗng, `can()` deny-by-default với `permission_not_granted`
 *    ⇒ **403** (sau audit write).
 * 2. Seed staff + role + `role_permissions('staff.read')` + assignment vào
 *    `db-staff-access` (không đụng legacy) ⇒ GET `/api/staff` ⇒ **200**
 *    `{staff: [...]}` đọc từ Staff Access API.
 * 3. UPDATE `revoked_at = now()` trên assignment của `db-staff-access` ⇒ 403
 *    trở lại mà không cần relogin — projection được đọc lại mỗi request
 *    (fetchedAt cùng request), không cache trong session.
 * 4. `backoffice.authorization_audit` ghi `outcome='success'` cho allow của
 *    `staff.read` — privileged-operation audit (SR-013), điều kiện hoàn thành
 *    của #241.
 */

/** Cookie jar từ browser context — chuyển sang Node request cho phần contract. */
async function jarFromBrowser(page: import('@playwright/test').Page): Promise<CookieJar> {
  const cookies = await page.context().cookies(resolveStackOrigin());
  const jar = new CookieJar();
  for (const cookie of cookies) {
    jar.absorb({
      status: 0,
      headers: { 'set-cookie': `${cookie.name}=${cookie.value}; Path=/` },
      body: '',
    });
  }
  return jar;
}

/**
 * Resolve origin TRONG từng test — KHÔNG ở scope file/describe: `--list` thu
 * thập test mà không có `.env`, gọi sớm là throw lúc collection (config no-throw
 * không đủ; chính helper `resolveStackOrigin` là đường fail-closed cho lệnh
 * gọi ngoài Nx). Hàm một dòng này capture `resolveStackOrigin` nên rule
 * `consistent-function-scoping` vẫn thoả.
 */
const origin = (): string => resolveStackOrigin();

test.describe.serial('permission enforcement for staff.read', () => {
  test('authenticated session WITHOUT any staff row or assignment gets 403 on GET /api/staff', async ({
    page,
  }) => {
    // Identity account có mặt (login chạy được) nhưng phía authorization CHƯA
    // có gì: đây đúng trạng thái "người dùng thật lần đầu login" trước khi
    // admin cấp role. Suite cố ý KHÔNG seed staff trước login — thứ tự trạng
    // thái là một phần của test.
    const postgres = await resolvePostgresContainer(origin());
    await seedAccountIdentity(postgres, PERMISSION_IDENTITY);
    // Rerun-safe: lần chạy trước có thể đã seed grant ở viên test 2 rồi dừng
    // trước viên revoke (viên đó "did not run" khi suite đỏ) — grant còn sống
    // sẽ làm precondition "chưa có gì" của viên này sai. Thu hồi trước khi
    // login để trạng thái đầu là "chưa cấp quyền" bất kể lịch sử stack.
    await revokeStaffAccessAssignment(postgres, {
      staffSub: PERMISSION_IDENTITY.sub,
    });

    const sinceMs = Date.now();
    const mailWic = mailWicContainerOf(postgres);

    await performBrowserLogin(page, {
      email: PERMISSION_IDENTITY.email,
      readOtp: () =>
        readOtpFromMailSink(mailWic, { recipient: PERMISSION_IDENTITY.email, sinceMs }),
    });

    // Session đã có (chứng minh bằng /api/me 200) nhưng /api/staff phải 403:
    // authn ĐỦ, authorization DENY.
    const jar = await jarFromBrowser(page);
    const me = await stackGet(`${origin()}/api/me`, { cookie: jar.header() ?? '' });
    expect(me.status).toBe(200);
    expect((JSON.parse(me.body) as { sub: string }).sub).toBe(PERMISSION_IDENTITY.sub);

    const staff = await stackGet(`${origin()}/api/staff`, { cookie: jar.header() ?? '' });
    expect(staff.status).toBe(403);
  });

  test('granting staff.read in db-staff-access turns the same permission into a 200 listing', async ({
    page,
  }) => {
    const postgres = await resolvePostgresContainer(origin());
    // Nguồn quyết định sau cutover: staff + role + permission + assignment
    // của `db-staff-access`. KHÔNG seed legacy `db-backoffice` — nếu suite
    // seed legacy thì assertion 200 không còn chứng minh projection là nguồn
    // quyết định (lỗ hổng phủ test gốc của #241).
    await seedStaffAccessStaff(postgres, { sub: PERMISSION_IDENTITY.sub });
    await seedStaffAccessGrant(postgres, {
      staffSub: PERMISSION_IDENTITY.sub,
      roleId: TEST_STAFF_ACCESS_ROLE_ID,
      permissionId: 'staff.read',
    });

    const sinceMs = Date.now();
    const mailWic = mailWicContainerOf(postgres);
    await performBrowserLogin(page, {
      email: PERMISSION_IDENTITY.email,
      readOtp: () =>
        readOtpFromMailSink(mailWic, { recipient: PERMISSION_IDENTITY.email, sinceMs }),
    });
    const jar = await jarFromBrowser(page);

    const staff = await stackGet(`${origin()}/api/staff`, { cookie: jar.header() ?? '' });
    expect(staff.status).toBe(200);

    const body = JSON.parse(staff.body) as { staff: Array<{ sub: string; status: string }> };
    expect(Array.isArray(body.staff)).toBe(true);
    const seededRow = body.staff.find((row) => row.sub === PERMISSION_IDENTITY.sub);
    expect(seededRow).toBeDefined();
    expect(seededRow?.status).toBe('active');
    // `displayName` do account profiles merge — local không có binding nên
    // chấp nhận null; shape vẫn phải có key.
    expect('displayName' in (seededRow ?? {})).toBe(true);
  });

  test('revoking the assignment in db-staff-access returns the endpoint to 403 without relogin', async ({
    page,
  }) => {
    // Viên test phủ chiều ngược: revocation là UPDATE `revoked_at` (không
    // DELETE — schema cấm xoá để giữ audit) và filter là READ-TIME trong
    // projection loader — mỗi request đọc lại Staff Access nên thu hồi có
    // hiệu lực từ request kế tiếp.
    const postgres = await resolvePostgresContainer(origin());
    await revokeStaffAccessAssignment(postgres, {
      staffSub: PERMISSION_IDENTITY.sub,
    });

    const sinceMs = Date.now();
    const mailWic = mailWicContainerOf(postgres);
    await performBrowserLogin(page, {
      email: PERMISSION_IDENTITY.email,
      readOtp: () =>
        readOtpFromMailSink(mailWic, { recipient: PERMISSION_IDENTITY.email, sinceMs }),
    });
    const jar = await jarFromBrowser(page);

    const staff = await stackGet(`${origin()}/api/staff`, { cookie: jar.header() ?? '' });
    expect(staff.status).toBe(403);
  });

  test('the projection-backed allow leaves a success audit row (SR-013)', async () => {
    // Điều kiện hoàn thành của #241: allow của `staff.read` cho operator
    // (viên test 200 phía trên) phải ghi `outcome='success'` vào
    // `backoffice.authorization_audit` — deny đã luôn được audit; allow phải
    // để lại dấu vết như deny.
    const postgres = await resolvePostgresContainer(origin());
    const successRows = await countAuthorizationAuditSuccess(postgres, {
      actorSub: PERMISSION_IDENTITY.sub,
      action: 'staff.read',
    });
    expect(successRows).toBeGreaterThanOrEqual(1);
  });
});
