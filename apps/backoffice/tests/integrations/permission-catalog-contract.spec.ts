/**
 * Contract test: mọi permission literal mà call-site enforcement dùng phải
 * **có thật** trong `backoffice.permissions` với `status = 'active'`.
 *
 * ## Gap mà test này đóng
 *
 * `CatalogPermission` là `string` tự do (`libs/backoffice-domain`), và
 * `requirePermission` **không** đối chiếu với catalog ở tầng DB — nó đánh giá
 * trên ảnh assignment đã đồng bộ (ADR-0009: không sync-call mỗi request).
 * Nên một id sai ở call-site không làm hỏng gì lúc chạy: nó chỉ khiến mọi
 * request của route đó bị deny (`403`) mà **không có gate đỏ** nào báo trước.
 *
 * Id sai đến từ đâu là rất dễ, và cả hai đều là lỗi thật:
 *
 * - copy từ fixture prototype (`delivery.redrive`, `mail.read`, `mail.send`,
 *   `audit.read` — ví dụ minh hoạ trong tài liệu, **không** có trong catalog);
 * - nhầm kiểu đặt tên (`staff:read` thay vì `staff.read`).
 *
 * Test này đối chiếu id đó với **catalog thật** trên PostgreSQL thật: cùng
 * một bảng `backoffice.permissions` mà `requirePermission` ngầm dựa vào, đọc
 * bằng **runtime role** — đúng credential Worker dùng.
 *
 * ⚠️ Docker là phụ thuộc cứng: probe Docker ở `harness.ts` (qua `globalSetup`)
 * ném lỗi khi vắng Docker, làm **toàn bộ** lần chạy đỏ thay vì skip — chính
 * sách fail-loud của 06-testing.md §6.
 */

import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readServerCallSites } from './permission-call-sites';
import { type BackofficeDatabase, startBackofficeDatabase } from './harness';

/**
 * Gốc project (`apps/backoffice`) — dùng để định vị cây `server/` và làm
 * đường dẫn tương đối trong báo cáo.
 *
 * ⚠️ `import.meta.dirname` chứ không phải `new URL(...).pathname`: trong
 * Vitest, `import.meta.url` của file ngoài `root` có tiền tố `/@fs/`, nên
 * `.pathname` cho ra một đường dẫn không tồn tại.
 */
const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const SERVER_DIR = join(PROJECT_ROOT, 'server');

describe('permission call sites resolve to an active row in the sealed catalog', () => {
  let db: BackofficeDatabase;

  beforeAll(async () => {
    db = await startBackofficeDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('resolves every permission literal used by an enforcement call site', async () => {
    const callSites = readServerCallSites(SERVER_DIR, PROJECT_ROOT);

    // Canary: máy quét phải **tìm thấy** call-site. Nếu máy quét hỏng (regex
    // sai, đường dẫn sai), danh sách rỗng ⇒ mọi assert bên dưới xanh vì
    // "không có gì để kiểm". Canary biến trường hợp đó thành đỏ.
    expect(callSites.length).toBeGreaterThan(0);

    const runtime = await db.asRuntime();
    try {
      const { rows } = await runtime.query<{ id: string; status: string }>(
        `SELECT id, status FROM backoffice.permissions`,
      );
      const catalog = new Map(rows.map((row) => [row.id, row.status]));

      const offending = callSites
        .filter((site) => catalog.get(site.permission) !== 'active')
        .map((site) => ({
          file: site.file,
          entryPoint: site.entryPoint,
          permission: site.permission,
          // `undefined` = không có row trong catalog; `'retired'` = có row
          // nhưng đã retire (terminal, không được dùng cho enforcement).
          catalogStatus: catalog.get(site.permission) ?? 'missing',
        }));

      expect(offending).toEqual([]);
    } finally {
      await runtime.end();
    }
  });

  it('finds the three read permissions the current routes declare', async () => {
    // Canary thứ hai: **danh sách id** tìm thấy phải khớp đúng ba route read
    // hiện tại. Nếu ai đó đổi tên route hoặc thêm route mới mà máy quét
    // không bắt, canary này đỏ — thay vì test xanh vì quét thiếu.
    const callSites = readServerCallSites(SERVER_DIR, PROJECT_ROOT);
    const permissions = [...new Set(callSites.map((site) => site.permission))].toSorted((a, b) =>
      a.localeCompare(b, 'en'),
    );

    // `staff.read` dùng bởi hai route (`staff.get`, `entitlements.get`) ⇒ deduplicate
    // trước khi so với catalog: 4 id duy nhất, không 5 lần gọi.
    expect(permissions).toEqual(['audit.read', 'permission.read', 'role.read', 'staff.read']);
  });

  it('does not accept an id that is not in the catalog', async () => {
    // Mutation evidence của chính test này: một id không có trong catalog
    // (ví dụ `staff.read.v2`, hoặc id copy từ fixture prototype
    // `delivery.redrive`) phải **không** resolve được.
    //
    // Test này không phụ thuộc code production nào — nó chứng minh rằng
    // điều kiện lọc của contract test có tác dụng, nên khi ai đó nới lỏng
    // nó (bỏ filter `status = 'active'`, hoặc đổi sang so khớp `undefined`)
    // thì test đỏ.
    const runtime = await db.asRuntime();
    try {
      const { rows } = await runtime.query<{ id: string; status: string }>(
        `SELECT id, status FROM backoffice.permissions`,
      );
      const active = new Set(rows.filter((row) => row.status === 'active').map((row) => row.id));

      for (const notInCatalog of ['staff.read.v2', 'delivery.redrive', 'staff:read']) {
        expect(active.has(notInCatalog)).toBe(false);
      }
    } finally {
      await runtime.end();
    }
  });
});
