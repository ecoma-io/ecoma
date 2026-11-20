import { join, resolve } from 'node:path';

import { defineCommand } from 'citty';

import {
  applyLocalD1Migrations,
  applyRemoteD1Migrations,
  requireSingleD1DatabaseName,
} from './worker-config.js';

/**
 * Entry `pnpm dx d1-migrate` — call site DUY NHẤT để áp migration D1 của một
 * app unit (cutover #382, hợp đồng `docs/architecture/02-delivery.md` §3a.4
 * và quyết định A+: authority D1 nằm ở app unit, một call site per app).
 *
 * Hai mode, bắt buộc chọn đúng một:
 * - `--local` (mặc định an toàn cho dev): áp vào D1 local của app qua
 *   `applyLocalD1Migrations` — state nằm ở `<app>/.wrangler/state` (gitignored),
 *   không cần credential nào.
 * - `--remote` (staging/production từ CI): đọc `ECOMA_CLOUDFLARE_API_TOKEN` từ
 *   env — thiếu là fail-closed, không bao giờ nhận token qua argv; token được
 *   map thành `CLOUDFLARE_API_TOKEN` chỉ trong subprocess wrangler.
 *
 * Tên database ĐỌC từ `wrangler.jsonc` của app (`database_name`, không phải
 * binding name — §3a.4), không nhận từ caller: gõ sai tên không thể tới được
 * wrangler. Mọi database khác một entry là lỗi cấu trúc.
 */
export default defineCommand({
  meta: {
    name: 'd1-migrate',
    description:
      'Apply D1 migrations of one app unit (the single migration call site per app, #382)',
  },

  args: {
    dir: {
      type: 'string',
      default: '.',
      description: 'App directory holding the committed wrangler.jsonc (default: cwd)',
    },
    local: {
      type: 'boolean',
      default: false,
      description: 'Apply against the app local D1 state (<app>/.wrangler/state)',
    },
    remote: {
      type: 'boolean',
      default: false,
      description: 'Apply against the remote D1 (requires ECOMA_CLOUDFLARE_API_TOKEN in env)',
    },
    env: {
      type: 'string',
      required: false,
      description: 'Forward a Wrangler named environment (--env <lane>) to the apply run',
    },
  },

  run({ args }) {
    const local = args['local'] === true;
    const remote = args['remote'] === true;
    if (local === remote) {
      console.error(
        '[d1-migrate] choose exactly one mode: --local (dev, no credentials) or --remote (CI lane)',
      );
      process.exitCode = 1;
      return;
    }
    const envLane = args['env'];
    if (
      (typeof envLane !== 'string' && envLane !== undefined) ||
      (typeof envLane === 'string' && envLane.trim().length === 0)
    ) {
      console.error('[d1-migrate] --env must be a non-empty lane name string');
      process.exitCode = 1;
      return;
    }
    const appDir = resolve(
      typeof args['dir'] === 'string' && args['dir'] !== '' ? args['dir'] : '.',
    );
    const configPath = join(appDir, 'wrangler.jsonc');
    try {
      if (local) {
        const databaseName = requireSingleD1DatabaseName(configPath);
        const stdout = applyLocalD1Migrations({
          configPath,
          databaseName,
          persistTo: join(appDir, '.wrangler', 'state'),
        });
        // Output wrangler là bằng chứng apply: bảng file đã áp, hay
        // "No migrations to apply" cho lần chạy thứ hai (no-op — §3a.4).
        const trimmed = stdout.trim();
        if (trimmed.length > 0) {
          console.log(trimmed);
        }
        console.log(`d1 migrations applied locally for '${databaseName}' (${configPath})`);
        return;
      }
      const databaseName = requireSingleD1DatabaseName(configPath);
      const stdout = applyRemoteD1Migrations({
        configPath,
        envLane,
      });
      // Output wrangler giữ nguyên làm bằng chứng apply (bảng file ✅/no-op);
      // không log gì thêm quanh token — token không bao giờ vào stdout/stderr.
      const trimmed = stdout.trim();
      if (trimmed.length > 0) {
        console.log(trimmed);
      }
      console.log(`d1 migrations applied remotely for '${databaseName}' (${configPath})`);
    } catch (error) {
      console.error(`[d1-migrate] ${(error as Error).message}`);
      process.exitCode = 1;
    }
  },
});
