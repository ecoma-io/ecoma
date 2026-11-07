/**
 * Harness D1 thật của suite integration app-owned `tests/integrations/` — đúng mô hình
 * của suite `mail-d1.spec.ts` cùng thư mục này nhưng **sở hữu riêng**:
 * 06-testing.md §1.3/§6 cấm chia sẻ test support giữa hai suite không có lý do tường minh,
 * nên harness này tự dựng state dir, tự apply migration và tự mở proxy — không import
 * harness nào của lib (lib cũng không export harness cho ai cả).
 *
 * HaiRunner, mỗi runner đúng vai trò của nó:
 *
 * - `wrangler d1 migrations apply` (CLI, tiến trình riêng) — đúng công cụ chạy production
 *   migration, nên database mà suite nhìn thấy là database mà runner thật dựng.
 * - `wrangler.getPlatformProxy` (in-process, workerd/miniflare) — chạy repository qua
 *   `prepare/bind/all/batch` với đúng API production.
 *
 * ⚠️ `persist.path` của proxy phải là `<stateDir>/v3`: CLI ghi state vào
 * `<persist-to>/v3/d1/…` còn proxy đọc `<persist.path>/d1/…` — thiếu đuôi `/v3` thì proxy
 * nhìn thấy một database rỗng (đã đo được ở `mail-d1.spec.ts` cùng thư mục, không phải suy đoán).
 *
 * ⚠️ Suite này KHÔNG phụ thuộc Docker: workerd chạy in-process qua devDependency
 * `wrangler`, không container nào được tạo — khác với các suite PostgreSQL
 * testcontainers của `apps/account`/`apps/auth`. Vì thế config integration của app này
 * không có `globalSetup` probe Docker (06-testing.md §6 chỉ bắt buộc fail-loud cho suite
 * **có** phụ thuộc Docker); phụ thuộc cứng thật của suite là binary workerd, và thiếu nó
 * thì `getPlatformProxy` ném ngay ở `beforeAll` — đỏ, không skip.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { D1Database } from '@cloudflare/workers-types';
import type { D1SubsetDatabase } from '@ecoma-io/transactional-mail-infrastructure';

const appDir = join(import.meta.dirname, '..', '..');
const wranglerConfig = join(appDir, 'wrangler.jsonc');

/** `require('wrangler')` thay vì `await import`: CLI bundle lớn, giữ ngoài pipeline transform của vitest (tiền lệ `mail-d1.spec.ts`). */
const req = createRequire(import.meta.url);
const wranglerCli = req.resolve('wrangler');

/** D1 binding mà `wrangler.jsonc` khai cho database `mail`. */
const BINDING = 'mail';

export interface MailD1Handle {
  /**
   * Database D1 thật, nhìn qua đúng subset mà persistence dùng. Gán qua biến kiểu
   * `D1SubsetDatabase` là khẳng định compile-time `D1Database extends D1SubsetDatabase` —
   * subset lệch khỏi `D1Database` thật thì dòng này không compile.
   */
  readonly db: D1SubsetDatabase;
  /** `SELECT` thô bằng binding thật — đường đọc độc lập với port đang được kiểm. */
  raw<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]>;
  /** Hàng đầu tiên của {@link raw}, hoặc `undefined` khi rỗng. */
  rawOne<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | undefined>;
  /** Đóng proxy và xoá state dir tạm — suite tự dọn sau khi chạy (06-testing.md §6). */
  stop(): Promise<void>;
}

interface D1Env {
  readonly [BINDING]: D1Database;
}

type MailProxy = Awaited<ReturnType<typeof makeMailProxy>>;

/** `getPlatformProxy` với Env của app này — hàm riêng để đặt generic một chỗ. */
async function makeMailProxy(stateDir: string): Promise<{
  readonly env: D1Env;
  readonly dispose: () => Promise<void>;
}> {
  const wrangler = req('wrangler') as typeof import('wrangler');
  return wrangler.getPlatformProxy<D1Env>({
    configPath: wranglerConfig,
    persist: { path: join(stateDir, 'v3') },
  });
}

/** Apply mọi migration file bằng đúng CLI production chạy, vào state dir tạm. */
function applyMigrations(stateDir: string): void {
  execFileSync(
    process.execPath,
    [
      wranglerCli,
      'd1',
      'migrations',
      'apply',
      BINDING,
      '--local',
      '--config',
      wranglerConfig,
      '--persist-to',
      stateDir,
    ],
    {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

/** Dựng database D1 thật cho một suite: migrations apply, mở proxy, trả handle. */
export async function startMailD1(): Promise<MailD1Handle> {
  const stateDir = mkdtempSync(join(tmpdir(), 'mail-integrations-'));
  applyMigrations(stateDir);

  const proxy: MailProxy = await makeMailProxy(stateDir);
  // Khẳng định compile-time: binding D1 thật thoả subset mà implementation đòi hỏi.
  const db: D1SubsetDatabase = proxy.env[BINDING];

  async function raw<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]> {
    const result = await proxy.env[BINDING]
      .prepare(sql)
      .bind(...binds)
      .all<T>();
    return result.results;
  }

  return {
    db,
    raw,
    async rawOne<T>(sql: string, ...binds: unknown[]): Promise<T | undefined> {
      return (await raw<T>(sql, ...binds))[0];
    },
    async stop(): Promise<void> {
      await proxy.dispose();
      rmSync(stateDir, { force: true, recursive: true });
    },
  };
}

/**
 * Render một giá trị test-control thành literal SQL — chỉ dùng cho giá trị do test tự
 * viết (seed), không phải cho giá trị của caller: đường caller đi qua `bind`.
 */
export function lit(value: string | number | null): string {
  if (value === null) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}
