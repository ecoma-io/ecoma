/**
 * Ghim bất biến **BFF chỉ đọc** — thứ mà test mount không thấy được vì nó là
 * tính chất của *tập tin route*, không phải của một component.
 *
 * BFF giữ một machine token server-side của deploy unit (SR-004): mọi request
 * từ dashboard được BFF forward bằng quyền của token đó, không phải của người
 * dùng. Với token tĩnh như vậy, một route ghi (`POST`/`DELETE`/`PUT`) trong
 * `server/api/broker/` là ghi bằng quyền deploy unit — AI biết URL cũng gọi
 * được. Nên tới khi có OIDC per-user, BFF chỉ được có method đọc (`GET`, và
 * `POST /api/broker/can-i-deploy` — truy vấn, không đổi trạng thái).
 *
 * Route DELETE record-undeployment từng tồn tại ở đây và bị XOÁ sau security
 * review: đường ghi hợp lệ là Pact CLI → API với machine token per-tenant.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BROKER_API_DIR = join(import.meta.dirname, '../server/api/broker');

/** Đệm liệt kê mọi file route dưới `server/api/broker/`. */
function routeFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));
}

/**
 * Route POST duy nhất được phép: `can-i-deploy` — truy vấn tri-state, không
 * đổi trạng thái broker (assert riêng ở test dưới: không forward method nào).
 * Hậu tố file của nó vẫn là `.post.ts`, nên carve-out tường minh ở đây thay
 * vì nới lỏng regex cho mọi file.
 */
const QUERY_POST_ROUTES = /can-i-deploy\.post\.ts$/u;

describe('BFF broker routes are read-only', () => {
  it('declares no write-method route file under server/api/broker', () => {
    const files = routeFiles(BROKER_API_DIR);
    // Cấu trúc thay đổi phải cập nhật test — không cho phép route mới lọt
    // qua im lặng khi quét.
    expect(files.length).toBeGreaterThanOrEqual(5);

    for (const file of files) {
      // Route ghi của Nitro phát biểu qua hậu tố file: `.post.ts`, `.delete.ts`,
      // `.put.ts`, `.patch.ts`. Ngoại lệ duy nhất: can-i-deploy (truy vấn).
      if (QUERY_POST_ROUTES.test(file)) continue;
      expect(file).not.toMatch(/\.(post|delete|put|patch)\.ts$/u);
    }
  });

  it('never mutates upstream state even inside GET handlers', () => {
    for (const file of routeFiles(BROKER_API_DIR)) {
      const source = readFileSync(file, 'utf8');
      // brokerCall chỉ được dùng với method đọc; POST duy nhất được phép là
      // can-i-deploy (truy vấn). Mọi method ghi khác là vi phạm bất biến.
      const writeCalls = [...source.matchAll(/method:\s*['"`](DELETE|PUT|PATCH|POST)['"`]/gu)].map(
        (m) => m[1],
      );
      // can-i-deploy POST không forward method POST đi — nó dựng query string;
      // rule vẫn phải chạy trên nó (writeCalls phải rỗng như mọi file khác).
      expect(writeCalls).toEqual([]);
    }
  });
});
