/**
 * Entry lifecycle local của `platform-deploy` — `up`/`down`/`smoke` trên stack
 * Pulumi của CHÍNH project này. Platform là node ĐẦU của lane local
 * (không `dependsOn` local-up nào); `local-smoke` của platform là node LÁ
 * (dependsOn duy nhất `home-deploy:local-up`).
 *
 * Chạy qua target Nx: `nx run platform-deploy:local-up -c local` → `npx tsx
 * local.ts up` (tương tự `down`/`smoke`). Entry KHÔNG lấy khóa lane nào:
 * lifecycle không có khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * `up` gồm ba giai đoạn:
 * 1. `resolvePostgresPassword` — đọc lại mật khẩu PostgreSQL từ stack config
 *    (canonical), chỉ sinh mới khi stack mới VÀ chưa có volume; fail có
 *    hướng dẫn khi config mất mà volume còn (không bao giờ sinh mật khẩu
 *    không khớp volume đã init).
 * 2. `pulumi up` — Traefik + PostgreSQL + network; outputs chỉ tồn tại sau
 *    khi up xanh.
 * 3. Đọc outputs (port Traefik thật do Docker cấp) rồi upsert `.env` đúng 3
 *    key sở hữu (ROOT_HOST/ROOT_DOMAIN/POSTGRES_PASSWORD); mọi key khác trong
 *    file giữ nguyên byte-for-byte. `.env` là artifact — nguồn sự thật là
 *    stack config/outputs; mọi unit kế tiếp đọc ROOT_HOST từ file này.
 *
 * `smoke` có đúng một prerequisite (`home-deploy:local-up`): smoke kiểm chuỗi
 * redirect `/` → `/en` của home qua Traefik với certificate local (script
 * `.mjs` cùng bản với orchestration cũ) — không đo unit nào khác nên không
 * kéo chúng vào.
 *
 * `down` xoá volume PostgreSQL VÔ ĐIỀU KIỆN sau khi destroy — không có tuỳ
 * chọn nào để giữ lại dữ liệu local (cờ opt-in giữ dữ liệu cũ đã bị xoá hoàn
 * toàn, KHÔNG thay bằng cờ/config tương đương). Destroy KHÔNG tự xoá volume
 * (`retainOnDelete`) nên hai kết quả tách rời: lỗi destroy và lỗi xoá volume
 * được theo dõi, báo và phản ánh vào exit code riêng biệt (xem
 * `runPlatformDown`). KHÔNG dùng `pulumi stack rm` — entry up của platform
 * fail có hướng dẫn khi config mất mà volume còn; down giữ stack rỗng
 * resource là cách hai nửa (config, volume) luôn cùng tuổi.
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import { join } from 'node:path';

import {
  POSTGRES_PASSWORD_ENV_KEY,
  ROOT_DOMAIN_ENV_KEY,
  ROOT_HOST_ENV_KEY,
  ensureStackForEntry,
  exec,
  pulumiUpForEntry,
  readRootHostFromEnv,
  resolveEntryFoundation,
  type EntryFoundation,
} from '@ecoma-io/deployment';
import { readPlatformOutputs, resolvePostgresPassword, upsertLocalEnv } from './platform-env.js';
import { runPlatformDown } from './platform-down.js';

/** Root của workspace, suy từ vị trí file này (`deploys/platform-deploy`). */
const WORKSPACE_ROOT = join(import.meta.dirname, '../..');

async function up(foundation: EntryFoundation): Promise<number> {
  try {
    // Stack phải tồn tại TRƯỚC khi đọc/ghi stack config: trên worktree chưa
    // từng deploy, `config get` trên backend `file://` exit 1 với lỗi
    // "unable to open state directory" — lỗi không phân biệt được với "lỗi
    // thật" và sẽ chặn nhánh sinh mật khẩu cho stack mới. Idempotent khi stack
    // đã có (xem `ensureStackForEntry`).
    ensureStackForEntry('platform-deploy', foundation);
    // Mật khẩu PostgreSQL: đọc lại từ stack config (canonical), chỉ sinh mới
    // khi stack mới VÀ chưa có volume. Fail-loud với hướng dẫn khi config mất
    // mà volume còn.
    const resolution = resolvePostgresPassword(foundation.ctx, foundation.env);
    if (!resolution.ok) {
      console.error(`[platform-deploy] ${resolution.error}`);
      return 1;
    }
    if (resolution.generated) {
      console.log(
        '[platform-deploy] postgres:password generated randomly and stored in the local stack config.',
      );
    }
    pulumiUpForEntry('platform-deploy', foundation);
    // Đọc outputs thực tế (port do Docker cấp chỉ tồn tại sau up), rồi upsert
    // `.env` (chỉ key sở hữu). `.env` nhận CÙNG giá trị mật khẩu đã lưu trong
    // stack config — mật khẩu không được sinh lần thứ hai ở đây: hai nguồn
    // lệch nhau là consumer đọc `.env` sẽ dùng mật khẩu khác với mật khẩu
    // Postgres thật.
    const outputs = readPlatformOutputs(
      join(WORKSPACE_ROOT, 'deploys', 'platform-deploy'),
      foundation.ctx,
      foundation.env,
    );
    const { envPath } = upsertLocalEnv(foundation.ctx.worktreeRoot, {
      [ROOT_HOST_ENV_KEY]: outputs.rootHost,
      [ROOT_DOMAIN_ENV_KEY]: outputs.rootHost,
      [POSTGRES_PASSWORD_ENV_KEY]: resolution.password,
    });
    console.log(
      `${ROOT_HOST_ENV_KEY}=${outputs.rootHost}, ${ROOT_DOMAIN_ENV_KEY}=${outputs.rootHost} and ` +
        `${POSTGRES_PASSWORD_ENV_KEY} written to ${envPath}`,
    );
    // Readiness đã thuộc container resource (`wait: true` trong index.ts cho
    // cả traefik lẫn postgres): `pulumi up` xanh đồng nghĩa healthcheck
    // `pg_isready` và `traefik healthcheck` đã chuyển `healthy` — routing
    // entrypoint mà mọi consumer đi qua đã phục vụ thật trước khi unit kế
    // tiếp (qua StackReference) bắt đầu.
    return 0;
  } catch (error) {
    console.error(
      `[platform-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

async function down(foundation: EntryFoundation): Promise<number> {
  // Toàn bộ sequence destroy + xoá volume (vô điều kiện) sống trong
  // `runPlatformDown` — tách module để spec bấm được ma trận lỗi thật qua
  // injection. Sequence không nằm trong khóa nào — lifecycle không có khóa toàn cục.
  return runPlatformDown(foundation);
}

async function main(command: string): Promise<number> {
  if (command === 'up') {
    const foundation = resolveEntryFoundation(true);
    if (foundation === undefined) {
      return 1;
    }
    return up(foundation);
  }
  if (command === 'down') {
    const foundation = resolveEntryFoundation(false);
    if (foundation === undefined) {
      console.log(
        '[platform-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    return down(foundation);
  }
  if (command === 'smoke') {
    const foundation = resolveEntryFoundation(false);
    // Smoke KHÔNG cần passphrase (chỉ đọc `.env` + HTTP) — worktree chưa từng
    // deploy thì `.env` không tồn tại và smoke fail với thông điệp rõ. Chạy
    // script smoke của system-tests (`@ecoma-io/local-smoke`): xác minh HTTPS
    // là hợp đồng của suite, không phải của entry.
    const rootHost = readRootHostFromEnv(foundation?.ctx.worktreeRoot ?? WORKSPACE_ROOT);
    if (rootHost === undefined) {
      console.error(
        '[platform-deploy] smoke: missing ROOT_HOST in .env — platform up has not run?',
      );
      return 1;
    }
    const smoke = exec(
      'node',
      [join(WORKSPACE_ROOT, 'system-tests/local-smoke/src/local-smoke.mjs'), rootHost],
      WORKSPACE_ROOT,
      process.env,
    );
    if (smoke.status !== 0) {
      console.error(`[platform-deploy] smoke HTTPS failed:\n${smoke.stdout}\n${smoke.stderr}`);
      return 1;
    }
    console.log(`[platform-deploy] smoke OK: https://${rootHost}/`);
    return 0;
  }
  console.error(`[platform-deploy] unknown command: ${command} (expected: up | down | smoke)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
