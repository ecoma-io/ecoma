import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Hợp đồng hai configuration của target `build` (#385) — assert trên
 * **artifact thật** của `apps/backoffice`.
 *
 * Target `build` có hai configuration:
 *
 * - `production` (default): Nitro preset `cloudflare-module`, artifact
 *   `.output/` — contract mà `wrangler.jsonc` trỏ tới, không được đổi;
 * - `development`: cùng cơ chế build production-mode nhưng preset
 *   `node-server`, artifact `.output-node/` với entrypoint chạy trực tiếp
 *   bằng `node` (local Docker lane).
 *
 * Cơ chế tách là khối `$env['node-docker']` trong `nuxt.config.ts`, kích hoạt
 * qua `--envName=node-docker`. Suite này ghim đúng cái bẫy "silent wrong
 * preset": nếu một bản refactor làm preset development trượt về
 * `cloudflare-module` (hoặc ngược lại làm production mất preset Worker),
 * `nitro.json` mà Nitro ghi vào artifact sẽ nói thật — đỏ ở đây thay vì xanh
 * với artifact sai hình dạng.
 *
 * ⚠️ Suite tự chạy `nx run @ecoma-io/backoffice:build:development` qua tiến trình
 * con: Nx cache làm lần chạy ấm gần như free, còn lần lạnh thì build thật
 * (~1 phút). `testTimeout` 120s khai trong `vitest.integration.config.mts` của app đủ cho lần lạnh (cả năm app cùng khai).
 */

const APP_DIR = resolve(import.meta.dirname, '..', '..');
const PROJECT = '@ecoma-io/backoffice';

/** `nitro.json` mà Nitro ghi kèm artifact — nơi preset thật được ghi lại. */
function nitroManifest(relativePath: string): { preset?: string; commands?: { preview?: string } } {
  return JSON.parse(readFileSync(resolve(APP_DIR, relativePath), 'utf8')) as {
    preset?: string;
    commands?: { preview?: string };
  };
}

describe('dual build output contract (#385)', () => {
  it('keeps the production artifact on the cloudflare-module worker preset', () => {
    // Contract wrangler: `.output/` phải là Worker bundle của preset
    // `cloudflare-module`. Suite chạy sau `build` (default configuration),
    // thiếu artifact là lỗi của pipeline — đỏ ngay ở readFile.
    expect(nitroManifest('.output/nitro.json').preset).toBe('cloudflare-module');
  });

  it('builds the development configuration into a standalone node-server artifact', () => {
    // Build development thật qua Nx (cache áp dụng như mọi task khác).
    // `NX_DAEMON=false` để tiến trình con tự liệt kê task mà không phụ thuộc
    // daemon nào đang sống.
    execFileSync('pnpm', ['exec', 'nx', 'run', `${PROJECT}:build:development`], {
      cwd: APP_DIR,
      stdio: 'pipe',
      env: { ...process.env, NX_DAEMON: 'false' },
      timeout: 110_000,
    });

    const manifest = nitroManifest('.output-node/nitro.json');
    expect(manifest.preset).toBe('node-server');
    // Entrypoint standalone: preview command của preset node-server là `node`.
    expect(manifest.commands?.preview).toContain('node server/index.mjs');
    expect(
      readFileSync(resolve(APP_DIR, '.output-node/server/index.mjs'), 'utf8').length,
    ).toBeGreaterThan(0);
  });

  it('does not disturb the production artifact while building development', () => {
    // Hai configuration dùng hai cặp thư mục riêng (`.nuxt-node`/`.output-node`
    // vs `.nuxt`/`.output`) — build development vừa chạy phải để nguyên
    // artifact production mà test-integration của app đang đọc.
    expect(nitroManifest('.output/nitro.json').preset).toBe('cloudflare-module');
  });
});
