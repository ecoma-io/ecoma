/**
 * Ghim disposition bất biến đọc-only của BFF sau #207 (ADR-0032 §5): bất
 * biến bị **thu hẹp, không bỏ** — write domain (publish/verify/
 * record-deployment/environment mutation) tiếp tục KHÔNG tồn tại dưới
 * `/api/broker/*`; write duy nhất được phép là credential management
 * (create/rotate/revoke machine token). Mọi mutation route đòi principal đã
 * verify (middleware authn + CSRF, test runtime ở
 * `tests/integrations/bff-auth-runtime.spec.ts`) và quyền theo ma trận được
 * enforce ở API side — BFF mirror không phải security boundary.
 *
 * Trước #206, BFF giữ một machine token server-side; một route ghi lúc đó là
 * ghi bằng quyền deploy unit. Từ #206 (ADR-0031 §4–5) BFF forward access
 * token của chủ phiên và API tự enforce role — route ghi credential vì thế
 * an toàn đúng nghĩa; route ghi domain khác vẫn bị cấm ở đây.
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

/** Route đọc không mang hậu tố method ghi. */
const isReadRoute = (file: string): boolean => !/\.(post|delete|put|patch)\.ts$/u.test(file);

/**
 * Write route được phép — credential management duy nhất (ADR-0032 §5). Mẫu
 * neo theo tên file: route mới thuộc loại khác phải sửa test này để khai
 * carve-out, không lọt qua im lặng.
 */
const CREDENTIAL_WRITE_ROUTES = [
  /machine-tokens\.post\.ts$/u,
  /machine-tokens[\\/]\[id\][\\/](rotate\.post|index\.delete)\.ts$/u,
  // Truy vấn POST duy nhất không đổi trạng thái broker (can-i-deploy).
  /can-i-deploy\.post\.ts$/u,
];

describe('BFF broker routes expose no write-domain surface', () => {
  it('declares no write-method route file outside the credential-management allowlist', () => {
    const files = routeFiles(BROKER_API_DIR);
    // Cấu trúc thay đổi phải cập nhật test — không cho phép route mới lọt
    // qua im lặng khi quét. `readdirSync(recursive)` đếm mọi .ts, kể cả spec
    // colocated và helper: hiện tại là 11 route + 2 spec colocated +
    // `test-principal.ts` (helper chung) = 14 file.
    expect(files).toHaveLength(14);

    for (const file of files) {
      if (isReadRoute(file)) continue;
      expect(
        CREDENTIAL_WRITE_ROUTES.some((pattern) => pattern.test(file)),
        `write route not in the ADR-0032 §5 allowlist: ${file}`,
      ).toBe(true);
    }
  });

  it('never mutates upstream state inside read handlers', () => {
    for (const file of routeFiles(BROKER_API_DIR)) {
      if (!isReadRoute(file)) continue;
      const source = readFileSync(file, 'utf8');
      // brokerCall chỉ được dùng với method đọc trong route đọc; method ghi
      // là vi phạm bất biến (route ghi có hậu tố riêng đã được allowlist).
      const writeCalls = [...source.matchAll(/method:\s*['"`](DELETE|PUT|PATCH|POST)['"`]/gu)].map(
        (m) => m[1],
      );
      expect(writeCalls).toEqual([]);
    }
  });

  it('keeps credential write routes strictly on the machine-tokens prefix', () => {
    // Non-goal "không publish pact qua browser" ghim theo diện: mọi route ghi
    // ngoài prefix credential là vi phạm bất kể allowlist phía trên.
    for (const file of routeFiles(BROKER_API_DIR)) {
      if (isReadRoute(file)) continue;
      expect(file.replace(/\\/gu, '/')).toMatch(/(machine-tokens|can-i-deploy)/u);
    }
  });
});
