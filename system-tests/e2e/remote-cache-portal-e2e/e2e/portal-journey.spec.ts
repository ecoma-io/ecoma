import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SECOND_TENANT_NAME, expect, seedOutsiderIdentity, test } from './support/fixtures';
import { performBrowserLogin } from './support/oidc-flow';
import { resolveStackOrigin, stackGet } from './support/local-origin';
import { resolvePlatformNetwork } from './support/network';

/**
 * Journey portal của developer trong tenant `ecoma` (issue #299):
 *
 * - **A27** tạo project qua UI.
 * - **A30** key đầu tiên show-once ĐÚNG MỘT LẦN.
 * - **A29** metadata list không chứa secret nào.
 * - **A31** revoke key ⇒ data-plane request kế tiếp bị từ chối ngay.
 * - **A32** key developer (untrusted) PUT cache ⇒ 403; người ngoài tenant bị
 *   từ chối fail-closed.
 *
 * Quy tắc: DB chỉ phục vụ fixture prep (làm trong fixture `identity`); mọi
 * assertion đều qua HTTP/browser — KHÔNG assert bằng cách đọc DB.
 *
 * ## Data-plane chỉ với tới được TỪ TRONG docker network
 *
 * `remote-cache-api` KHÔNG có router Traefik (quyết định #238 — service nội
 * bộ); host không route vào network platform. Mọi assertion data-plane chạy
 * `curl` trong một container dùng chung network với stack — cùng đường mà Nx
 * CLI thật sẽ đi (spec `nx-cli-journey.spec.ts`).
 */

const execFileAsync = promisify(execFile);

/** Alias nội bộ của data-plane trên network platform — hằng theo deploy (#238). */
const DATA_PLANE_ALIAS = 'ecoma-remote-cache-api';
const DATA_PLANE_PORT = 4207;

/** Chạy `curl` trong network platform, trả `{status, body}`. */
async function curlInNetwork(
  network: string,
  args: string[],
): Promise<{ status: number; body: string }> {
  const { stdout } = await execFileAsync('docker', [
    'run',
    '--rm',
    `--network=${network}`,
    'curlimages/curl',
    '-s',
    '-o',
    '/dev/stderr',
    '-w',
    '%{http_code}',
    '-m',
    '10',
    ...args,
  ]);
  return { status: Number(stdout), body: '' };
}

// Ghi body stderr không cần — assertion data-plane của suite chỉ cần status.

const PORTAL_ORIGIN = resolveStackOrigin();

test.describe.serial('remote-cache portal developer journey', () => {
  let network: string;
  let projectName: string;
  /** Token show-once của key A30 — giữ trong bộ nhớ test process (không DB). */
  let firstKeyToken: string | undefined;

  test.beforeAll(async () => {
    network = await resolvePlatformNetwork(PORTAL_ORIGIN);
  });

  test('A27: login and create a project through the portal UI', async ({
    page,
    identity,
  }, testInfo) => {
    projectName = `e2e-portal-${testInfo.workerIndex}-${Date.now().toString(36)}`;

    await page.goto('/');
    await performBrowserLogin(page, {
      email: identity.email,
      readOtp: () => identity.readOtp(Date.now() - 60_000),
    });

    // Trang chủ portal: danh sách project của tenant mà membership của phiên
    // resolve tới (`ecoma`).
    await expect(page.getByTestId('remote-cache-app-projects-table')).toBeVisible();

    await page.getByTestId('remote-cache-app-create-project-link').click();
    await page.getByTestId('remote-cache-app-create-project-name').fill(projectName);
    await page.getByTestId('remote-cache-app-create-project-submit').click();

    // Tạo project OK (201) trả ngay key đầu tiên show-once — dialog hiện trên
    // CÙNG trang create (trang không điều hướng đi đâu khác).
    await expect(page.getByTestId('remote-cache-app-show-once')).toBeVisible();
    const bootstrapToken = (
      await page.getByTestId('remote-cache-app-show-once-token').innerText()
    ).trim();
    expect(bootstrapToken.length).toBeGreaterThan(8);
    await page.getByTestId('remote-cache-app-show-once-confirm').click();
  });

  test('A30: first key is shown exactly once and A29 metadata carries no secrets', async ({
    page,
    identity,
  }) => {
    await page.goto('/');
    await performBrowserLogin(page, {
      email: identity.email,
      readOtp: () => identity.readOtp(Date.now() - 60_000),
    });

    await page.getByRole('link', { name: projectName }).click();
    await expect(page.getByTestId('remote-cache-app-keys-title')).toBeVisible();

    // Tạo key đầu tiên ⇒ dialog show-once với token.
    await page.getByTestId('remote-cache-app-create-key').click();
    await expect(page.getByTestId('remote-cache-app-show-once')).toBeVisible();
    firstKeyToken = (await page.getByTestId('remote-cache-app-show-once-token').innerText()).trim();
    expect(firstKeyToken.length).toBeGreaterThan(8);

    await page.getByTestId('remote-cache-app-show-once-confirm').click();

    // A29: bảng metadata KHÔNG chứa token — key chỉ hiện metadata (class
    // developer, không trusted-ci badge).
    const tableText = await page.getByTestId('remote-cache-app-keys-table').innerText();
    expect(tableText).not.toContain(firstKeyToken);
    await expect(page.getByTestId('remote-cache-app-key-class-developer').first()).toBeVisible();

    // A30 ép "đúng một lần": list metadata qua BFF (phiên browser) không trả
    // secret — token không thể lấy lại từ bất kỳ đường read nào.
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === '__Host-remote-cache-app-session');
    const csrf = cookies.find((c) => c.name === '__Host-remote-cache-app-csrf');
    if (session === undefined || csrf === undefined) {
      throw new Error('portal session cookies missing after login — auth flow did not complete');
    }
    const list = await stackGet(
      `${PORTAL_ORIGIN}/api/portal/tenants/ecoma/projects/${projectName}/api-keys`,
      {
        cookie: `__Host-remote-cache-app-session=${session.value}; __Host-remote-cache-app-csrf=${csrf.value}`,
      },
    );
    expect(list.status).toBe(200);
    expect(list.body).not.toContain(firstKeyToken);
    expect(list.body).not.toContain('token_hash');
  });

  test('A31: revoked key is rejected immediately by the data plane', async ({
    page,
    identity,
  }, testInfo) => {
    testInfo.setTimeout(120_000);
    await page.goto('/');
    await performBrowserLogin(page, {
      email: identity.email,
      readOtp: () => identity.readOtp(Date.now() - 60_000),
    });
    await page.getByRole('link', { name: projectName }).click();
    await expect(page.getByTestId('remote-cache-app-keys-table')).toBeVisible();

    // Key thứ hai cho journey revoke (key A30 vẫn giữ trong firstKeyToken).
    await page.getByTestId('remote-cache-app-create-key').click();
    await expect(page.getByTestId('remote-cache-app-show-once')).toBeVisible();
    const revokeToken = (
      await page.getByTestId('remote-cache-app-show-once-token').innerText()
    ).trim();
    await page.getByTestId('remote-cache-app-show-once-confirm').click();

    // Data-plane: key developer portal là read-only — GET entry chưa tồn tại
    // với key CÒN ACTIVE ⇒ 404 (miss): auth đạt, không có entry.
    const hash = 'a31'.padEnd(64, '0');
    const before = await curlInNetwork(network, [
      '-H',
      `Authorization: Bearer ${revokeToken}`,
      `http://${DATA_PLANE_ALIAS}:${DATA_PLANE_PORT}/v1/cache/${hash}`,
    ]);
    expect(before.status).toBe(404);

    // Revoke qua UI (dialog xác nhận). List key sort theo created_at TĂNG DẦN
    // (query `ORDER BY created_at, id`) nên key vừa tạo ở test này là row
    // CUỐI trong bảng — revoke row đó, không phải key bootstrap của A27
    // (row đầu) hay key A30.
    const activeRow = page
      .locator('[data-testid^="remote-cache-app-key-row-"]')
      .filter({ hasText: 'Active' })
      .last();
    await activeRow.locator('[data-testid^="remote-cache-app-revoke-"]').click();
    await expect(page.getByTestId('remote-cache-app-revoke-confirm')).toBeVisible();
    await page.getByTestId('remote-cache-app-revoke-confirm-submit').click();

    // Key revoked vẫn nằm trong list, đánh dấu revoked.
    await expect(page.getByTestId('remote-cache-app-keys-table')).toContainText('Revoked');

    // A31: revoke CÓ HIỆU LỰC NGAY — cùng token vừa GET 404 nay 401.
    const after = await curlInNetwork(network, [
      '-H',
      `Authorization: Bearer ${revokeToken}`,
      `http://${DATA_PLANE_ALIAS}:${DATA_PLANE_PORT}/v1/cache/${hash}`,
    ]);
    expect(after.status).toBe(401);
  });

  test('A32: developer key PUT is 403 and an outsider tenant is denied', async ({
    browser,
    identity,
  }, testInfo) => {
    testInfo.setTimeout(150_000);
    // Insider = fixture `identity` (member của `ecoma`) tạo project + key qua UI.
    // Contexts đóng trong finally — assert nào đỏ vẫn không rò rỉ context.
    const insiderContext = await browser.newContext();
    try {
      const insiderPage = await insiderContext.newPage();
      await insiderPage.goto('/');
      await performBrowserLogin(insiderPage, {
        email: identity.email,
        readOtp: () => identity.readOtp(Date.now() - 60_000),
      });
      const a32Project = `e2e-a32-${testInfo.workerIndex}-${Date.now().toString(36)}`;
      await insiderPage.getByTestId('remote-cache-app-create-project-link').click();
      await insiderPage.getByTestId('remote-cache-app-create-project-name').fill(a32Project);
      await insiderPage.getByTestId('remote-cache-app-create-project-submit').click();
      // Tạo project OK trả show-once key bootstrap ngay trên trang create.
      await expect(insiderPage.getByTestId('remote-cache-app-show-once')).toBeVisible();
      const devToken = (
        await insiderPage.getByTestId('remote-cache-app-show-once-token').innerText()
      ).trim();
      await insiderPage.getByTestId('remote-cache-app-show-once-confirm').click();

      // A32a: developer key (untrusted, read-only) PUT cache ⇒ 403.
      const put = await curlInNetwork(network, [
        '-X',
        'PUT',
        '--data-binary',
        'e2e',
        '-H',
        `Authorization: Bearer ${devToken}`,
        `http://${DATA_PLANE_ALIAS}:${DATA_PLANE_PORT}/v1/cache/a32${'0'.repeat(61)}`,
      ]);
      expect(put.status).toBe(403);

      // Outsider: identity của tenant khác login bằng context riêng và gọi
      // portal của `ecoma`.
      const outsider = await seedOutsiderIdentity(
        PORTAL_ORIGIN,
        `a32-outsider-${testInfo.workerIndex}`,
      );
      const outsiderContext = await browser.newContext();
      try {
        const outsiderPage = await outsiderContext.newPage();
        await outsiderPage.goto('/');
        await performBrowserLogin(outsiderPage, {
          email: outsider.email,
          readOtp: () => outsider.readOtp(Date.now() - 60_000),
        });
        const outsiderCookies = await outsiderPage.context().cookies();
        const session = outsiderCookies.find((c) => c.name === '__Host-remote-cache-app-session');
        const csrf = outsiderCookies.find((c) => c.name === '__Host-remote-cache-app-csrf');
        if (session === undefined || csrf === undefined) {
          throw new Error(
            'outsider session cookies missing after login — auth flow did not complete',
          );
        }
        const cookieHeader = `__Host-remote-cache-app-session=${session.value}; __Host-remote-cache-app-csrf=${csrf.value}`;

        // Tenant `ecoma` tồn tại nhưng outsider không phải member ⇒ 403.
        const ecomaList = await stackGet(`${PORTAL_ORIGIN}/api/portal/tenants/ecoma/projects`, {
          cookie: cookieHeader,
        });
        expect(ecomaList.status).toBe(403);
        expect(ecomaList.body).not.toContain(a32Project);

        // Tenant của chính outsider được resolve riêng — KHÔNG thấy data `ecoma`.
        const ownList = await stackGet(
          `${PORTAL_ORIGIN}/api/portal/tenants/${SECOND_TENANT_NAME}/projects`,
          { cookie: cookieHeader },
        );
        expect(ownList.status).toBe(200);
        expect(ownList.body).not.toContain(a32Project);
        expect(ownList.body).not.toContain('ecoma');
      } finally {
        await outsiderContext.close();
      }
    } finally {
      await insiderContext.close();
    }
  });
});
