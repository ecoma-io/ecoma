/**
 * Harness D1 thật cho app `web-push-notification-job` — **bản sao riêng**, không import
 * chéo project.
 *
 * ⚠️ **Vì sao không import từ lib.** `libs/web-push-notification-job-infrastructure` từng có
 * harness riêng cho `d1-job-state-repository.spec.ts` (suite đã dời vào thư mục này). Import
 * harness từ lib khác là một dependency chạy-test chéo project — và
 * `apps/transactional-mailer-job` đã có bản sao riêng chính vì lý do đó
 * (`src/mail-job-repository.spec.ts` mở đầu bằng đúng câu này). Harness rẻ và
 * một bản sao độc lập là thứ duy nhất bắt được việc hai bên lệch `wrangler.jsonc`.
 *
 * ⚠️ **D1 thật, không fake.** `INSERT OR IGNORE` + `meta.changes`, `UPDATE … WHERE` có guard,
 * và CHECK/trigger của schema chỉ có nghĩa trên engine SQL thật với migration thật. Test
 * migration ở đây áp **đúng file trong `migrations/`** theo **đúng thứ tự tên file**.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { D1DatabaseLike } from '@ecoma-io/web-push-notification-job-infrastructure';

// Không gửi telemetri khi spawn workerd trong test.
process.env['WRANGLER_SEND_METRICS'] = 'false';

const requireFromSpec = createRequire(import.meta.url);
const { getPlatformProxy } = requireFromSpec('wrangler') as typeof import('wrangler');

/**
 * Đường dẫn `migrations/` neo bằng `import.meta.url`.
 *
 * ⚠️ **Không** dùng `dirname(import.meta.dirname)`: vitest chạy với `root` là thư mục project,
 * nên `import.meta.dirname` ở đây không nhất quán với vị trí file thật trên đĩa, và điều hướng
 * bằng nó từng trỏ `migrations/` vào `apps/migrations` — thư mục không tồn tại. `new URL(…)`
 * theo chuẩn ES module luôn neo đúng file đang chạy, bất kể `root` của runner là gì.
 *
 * `appDir` không còn dùng ở đây: caller truyền `configPath` của chính nó (mỗi spec tự neo
 * `../wrangler.jsonc` bằng URL tương đối với file của nó), nên harness không cần — và giữ một
 * biến không dùng sẽ là lint đỏ vô nghĩa mà không ai đọc.
 */
const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Mốc thời gian tuyệt đối — mọi biên được tính trên giá trị tường minh, không dùng đồng hồ. */
export const T0 = 1_800_000_000_000;
export const DAY_MS = 86_400_000;

/**
 * Tách statement từ file migration, theo **thứ tự tên file**.
 *
 * ⚠️ **Phải hiểu `CREATE TRIGGER`.** Trigger `push_jobs_envelope_forbidden_key_guard` có thân
 * `BEGIN … END;` — và dấu `;` bên trong thân trigger làm một cách tách "cắt quanh mọi `;`"
 * hủy statement (SQLite báo `incomplete input`). Thân trigger chỉ được coi là khối khi
 * `BEGIN` đứng sau `CREATE TRIGGER`; `END` đóng khối đó. Tự động thử trên SQLite:
 * `CREATE TRIGGER … END` **không** có `;` cuối vẫn được chấp nhận, nên khối đóng đúng là
 * `… END` và `;` sau đó là dấu kết câu.
 */
export function statementsOf(sql: string): string[] {
  const withoutComments = sql.replace(/--[^\n]*/gu, '');
  const statements: string[] = [];
  let current = '';
  let inTriggerBody = false;
  for (const token of withoutComments.split(';')) {
    current = current.length === 0 ? token : `${current};${token}`;
    if (!inTriggerBody && /\bCREATE\s+TRIGGER\b/iu.test(current)) {
      inTriggerBody = true;
      continue;
    }
    if (inTriggerBody) {
      if (/(?:^|\s)END\s*$/iu.test(token)) {
        inTriggerBody = false;
        statements.push(current.trim());
        current = '';
      }
      continue;
    }
    if (current.trim().length > 0) {
      statements.push(current.trim());
    }
    current = '';
  }
  const tail = current.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }
  return statements;
}

/** Tên file migration, theo thứ tự áp dụng — không phải thứ tự của `readdirSync`. */
export function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .toSorted((left, right) => left.localeCompare(right, 'en'));
}

/** Nội dung gộp của mọi migration, theo thứ tự áp dụng. */
export function migrationStatements(): string[] {
  return migrationFiles().flatMap((name) =>
    statementsOf(readFileSync(join(migrationsDir, name), 'utf8')),
  );
}

export interface D1Harness {
  readonly db: D1DatabaseLike;
  /** Xoá sạch dữ liệu giữa các test — mỗi test bắt đầu từ một bảng rỗng. */
  readonly reset: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  /** Áp lại toàn bộ migration — dùng khi một test cần trạng thái schema sạch. */
  readonly applyMigrations: () => Promise<void>;
}

export async function createD1Harness(configPath: string): Promise<D1Harness> {
  const persistDir = mkdtempSync(join(tmpdir(), 'web-push-job-app-'));
  const proxy = await getPlatformProxy({
    configPath,
    persist: { path: persistDir },
  });
  const db = (proxy.env as Record<string, unknown>)['push-job'] as D1DatabaseLike;
  if (db === undefined) {
    await proxy.dispose();
    rmSync(persistDir, { recursive: true, force: true });
    throw new Error('binding `push-job` is missing from wrangler.jsonc');
  }

  const applyMigrations = async (): Promise<void> => {
    for (const statement of migrationStatements()) {
      await db.prepare(statement).run();
    }
  };

  return {
    db,
    applyMigrations,
    reset: async () => {
      await db.prepare('DELETE FROM push_job_attempts').run();
      await db.prepare('DELETE FROM push_jobs').run();
    },
    dispose: async () => {
      await proxy.dispose();
      rmSync(persistDir, { recursive: true, force: true });
    },
  };
}
