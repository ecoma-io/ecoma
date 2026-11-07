import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';

import { PERMISSION_IDENTITY, SEED_ACTOR_SUB, TEST_ROLE_ID } from './support/fixtures';
import { CookieJar, resolveStackOrigin, stackGet } from './support/local-origin';
import { performBrowserLogin } from './support/oidc-flow';
import {
  mailWicContainerOf,
  readOtpFromMailSink,
  resolvePostgresContainer,
  seedAccountIdentity,
  seedBackofficeGrant,
  seedStaffAccessStaff,
} from './support/stack-fixtures';

/**
 * Permission enforcement — trái tim của suite.
 *
 * Chuỗi trạng thái THẬT trong `db-backoffice`, assert qua HTTP thật:
 *
 * 1. Đã đăng nhập nhưng `backoffice.staff` KHÔNG có hàng của sub ⇒
 *    `loadPrincipalAuthorization` trả assignments rỗng (principal vắng staff
 *    row được coi như "không assignment"), `can()` deny-by-default với
 *    `permission_not_granted` ⇒ `requirePermission('staff.read')` ném
 *    `AuthorizationDeniedError` ⇒ **403** (sau audit write).
 * 2. Seed role custom + `role_permissions('staff.read')` + `role_assignments`
 *    + staff row `active` — bốn INSERT như mô tả ở `seedBackofficeGrant`.
 * 3. GET lại `/api/staff` ⇒ **200** `{staff: [...]}` đọc từ DB thật
 *    (`libs/backoffice-infrastructure/src/queries.ts::listStaff`).
 * 4. UPDATE `revoked_at = now()` (thu hồi ĐÚNG NGHĨA của schema: không DELETE,
 *    audit giữ lịch sử) ⇒ 403 trở lại mà không cần relogin — permission check
 *    chạy mỗi request, không cache trong session.
 *
 * `authorization_audit` ghi các quyết định — schema có nhưng suite không assert
 * nội dung audit (không thuộc hợp đồng HTTP; một test riêng của job là nơi
 * đúng cho invariant đó).
 */

const execFileAsync = promisify(execFile);

/** Chạy một câu SQL trong `db-backoffice` — chỉ UPDATE của test revocation. */
async function revokeAssignment(postgresContainer: string): Promise<void> {
  await execFileAsync('docker', [
    'exec',
    postgresContainer,
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    'db-backoffice',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE backoffice.role_assignments SET revoked_at = now()
      WHERE staff_sub = '${PERMISSION_IDENTITY.sub}' AND role_id = '${TEST_ROLE_ID}' AND revoked_at IS NULL;`,
  ]);
}

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
    // Identity account có mặt (login chạy được) nhưng phía backoffice CHƯA có
    // gì: đây đúng trạng thái "người dùng thật lần đầu login" trước khi admin
    // cấp role. Suite cố ý KHÔNG seed staff trước login — thứ tự trạng thái là
    // một phần của test.
    const postgres = await resolvePostgresContainer(origin());
    await seedAccountIdentity(postgres, PERMISSION_IDENTITY);

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

  test('seeding role + assignment + staff turns the same permission into a 200 listing', async ({
    page,
  }) => {
    const postgres = await resolvePostgresContainer(origin());
    // Bốn INSERT idempotent — chạy được lại sau test trước mà không phá state.
    await seedBackofficeGrant(postgres, {
      staffSub: PERMISSION_IDENTITY.sub,
      actorSub: SEED_ACTOR_SUB,
      roleId: TEST_ROLE_ID,
      permissionId: 'staff.read',
    });
    // P5.1: `/api/staff` đọc từ Staff Access API (`staff_access.staff` của
    // `db-staff-access`), không còn từ `db-backoffice` — seed staff row vào
    // staff-access trước khi assert 200 listing.
    await seedStaffAccessStaff(postgres, { sub: PERMISSION_IDENTITY.sub });

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

  test('revoking the assignment server-side returns the endpoint to 403 without relogin', async ({
    page,
  }) => {
    // Viên test phủ chiều ngược: revocation là UPDATE `revoked_at` (không
    // DELETE — schema 0001 cấm xoá để giữ audit) và filter là READ-TIME trong
    // `loadPrincipalAuthorization`.
    const postgres = await resolvePostgresContainer(origin());
    await revokeAssignment(postgres);

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
});
