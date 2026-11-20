/**
 * Pipeline `wrangler secret put` / `wrangler versions secret put` có kiểm
 * soát cho Worker staging (issue #351; hợp đồng `02-delivery.md` §6 mục 7,
 * §6.12; platform facts WS1/WS3).
 *
 * Ba ranh giới identity (#373 mục A/E) mà module này phân biệt tường minh:
 * - runtime credential — secret của Worker, đặt qua wrangler theo môi trường
 *   deploy (`stg-<...>`, WS3: secret KHÔNG kế thừa giữa named environments);
 * - migrator credential (`_migrator` per-DB) — KHÔNG đi qua đường này, chỉ
 *   sống trong CI secret store của migration lane;
 * - control-plane credential — org secret `ECOMA_CLOUDFLARE_API_TOKEN` dùng
 *   chung duy nhất, map vào `CLOUDFLARE_API_TOKEN` CHỈ trong env của
 *   subprocess wrangler (§6.12: không per-env credential, không alias).
 *
 * Hai hành động, đúng §6 mục 7:
 * - `put` — provision lần đầu: `wrangler secret put` DEPLOY NGAY một version
 *   mới (WS1), chỉ dùng khi provision ban đầu;
 * - `stage` — xoay vòng: `wrangler versions secret put` chỉ stage version
 *   mới, KHÔNG deploy — publish đi qua `versions deploy` của delivery gate,
 *   không bao giờ bypass gate bằng đường xoay secret.
 *
 * Fail-closed: thiếu token là dừng với tên biến; Worker bắt buộc là identity
 * staging `stg-<...>` đọc từ khối `env.staging.name` của wrangler.jsonc —
 * tên khác `stg-` (ví dụ `ecoma-home` production) là TỪ CHỐI trước khi wrangler
 * chạy. Giá trị secret chỉ đi qua stdin, KHÔNG BAO GIỜ qua argv
 * (`/proc/<pid>/cmdline` đọc được) và không bao giờ được log.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { exec, type ExecResult } from '@ecoma-io/deployment';

/** Hành động secret: `put` (provision, deploy ngay) | `stage` (xoay, chỉ stage). */
export type SecretAction = 'put' | 'stage';

/** Control-plane token duy nhất của pipeline (§6.12) — org secret GitHub. */
export const CONTROL_PLANE_TOKEN_ENV_KEY = 'ECOMA_CLOUDFLARE_API_TOKEN';

/** Deps inject để spec chạy không cần wrangler/config thật. */
export interface WorkerSecretDeps {
  execFn: (
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    options?: { input?: string },
  ) => ExecResult;
  readTextFile: (path: string) => string;
}

const defaultDeps: WorkerSecretDeps = {
  execFn: (command, args, cwd, env, options = {}) => exec(command, args, cwd, env, options),
  readTextFile: (path) => readFileSync(path, 'utf8'),
};

/**
 * Inventory credential fail-closed (đối xứng `resolveStagingRunEnv` của
 * `deploys/*`): thiếu `ECOMA_CLOUDFLARE_API_TOKEN` là dừng với đúng tên biến
 * — không fallback sang credential nào khác (§6.12 cấm alias/per-env token).
 * Env trả về là danh sách TỐI THIỂU cho subprocess wrangler: token chỉ tồn
 * tại dưới tên `CLOUDFLARE_API_TOKEN` trong env của process này. Token KHÔNG
 * được trả ra ngoài — giá trị nhạy cảm không rời hàm này ngoài env của
 * subprocess (tránh lan truyền giá trị nhạy cảm qua return value).
 */
export function resolveSecretRunEnv(source: NodeJS.ProcessEnv = process.env): {
  env: NodeJS.ProcessEnv;
} {
  const token = source[CONTROL_PLANE_TOKEN_ENV_KEY];
  if (token === undefined || token.trim().length === 0) {
    throw new Error(
      `${CONTROL_PLANE_TOKEN_ENV_KEY} is not set — provision the shared org secret per ` +
        'docs/architecture/staging-prerequisites.md; refusing to run wrangler with any ' +
        'other credential source (§6.12: one shared token, no per-env credentials)',
    );
  }
  const env: NodeJS.ProcessEnv = {
    // PATH/HOME fallback về process hiện tại: source env của caller (spec,
    // harness) có thể không mang hai biến này mà wrangler vẫn cần để chạy.
    PATH: source.PATH ?? process.env.PATH,
    HOME: source.HOME ?? process.env.HOME,
    CI: '1',
    CLOUDFLARE_API_TOKEN: token,
  };
  return { env };
}

/** Identity Worker hợp lệ cho pipeline này: chỉ staging `stg-<...>` — suffix bắt buộc không rỗng. */
export function classifyWorkerName(name: string): 'staging' | 'refused' {
  return /^stg-.+$/u.test(name) ? 'staging' : 'refused';
}

/**
 * Tên secret Worker hợp lệ: identifier ASCII (chữ/số/gạch dưới, không mở đầu
 * bằng số) — cùng ràng buộc làm JS binding identifier của Workers.
 */
export function validateSecretName(raw: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(raw)) {
    throw new Error(
      `invalid secret name "${raw}" — use an ASCII identifier: letters, digits, underscore, not starting with a digit`,
    );
  }
  return raw;
}

/**
 * Chuẩn hoá JSONC thành JSON để JSON.parse đọc được: bỏ comment (dòng + khối)
 * và dấu phẩy thừa trước `}`/`]` — cả hai chỉ xảy ra ngoài string literal,
 * quét một lượt có nhận thức string để không đụng nội dung trong chuỗi.
 */
export function stripJsoncComments(text: string): string {
  let out = '';
  let index = 0;
  const len = text.length;
  let inString = false;
  while (index < len) {
    const char = text[index] as string;
    if (inString) {
      out += char;
      if (char === '\\') {
        const next = text[index + 1];
        if (next !== undefined) {
          out += next;
          index += 1;
        }
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < len && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) throw new Error('unterminated block comment in JSONC config');
      index = end + 2;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < len && /\s/u.test(text[lookahead] as string)) lookahead += 1;
      const next = text[lookahead];
      if (next === '}' || next === ']') {
        index += 1; // Bỏ dấu phẩy thừa, giữ ký tự đóng.
        continue;
      }
    }
    out += char;
    index += 1;
  }
  // Vẫn đang trong chuỗi khi hết input là config JSONC hỏng — fail-closed thay
  // vì trả về JSON lệch để JSON.parse ném lỗi khó hiểu phía sau.
  if (inString) {
    throw new Error('unterminated string literal in JSONC config');
  }
  return out;
}

/**
 * Đọc Worker identity staging từ config wrangler: BẮT BUỘC khối
 * `env.staging.name` — config không khai tên staging là từ chối, KHÔNG rơi về
 * tên top-level (WS3: dùng nhầm tên top-level là deploy secret lên đúng
 * Worker production-env hoặc Worker không env, hai khả năng đều sai).
 */
export function stagingWorkerNameFromConfig(configText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncComments(configText));
  } catch (error) {
    throw new Error(
      `wrangler config is not valid JSON(C): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const staging = (parsed as { env?: { staging?: { name?: unknown } } }).env?.staging;
  const name = staging?.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(
      'wrangler config declares no env.staging.name — refusing to resolve a worker name ' +
        'from the top-level name (WS3: secrets do not inherit between named environments)',
    );
  }
  return name;
}

/** Đối số wrangler cho một hành động secret — `--env staging` luôn tường minh. */
export function buildWranglerSecretArgs(
  action: SecretAction,
  secretName: string,
  configPath: string,
): string[] {
  const command = action === 'stage' ? ['versions', 'secret', 'put'] : ['secret', 'put'];
  return [...command, secretName, '--env', 'staging', '--config', configPath];
}

/** Cắt MỘT newline cuối (echo/printf thêm) — nội dung còn lại giữ nguyên vẹn. */
export function trimTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, '');
}

/**
 * Chạy MỘT hành động secret lên Worker staging của config.
 *
 * Thứ tự kiểm trước khi wrangler chạy: action hợp lệ → tên secret hợp lệ →
 * giá trị không rỗng → inventory token → worker identity `stg-` từ config →
 * wrangler với giá trị qua stdin. Bất kỳ bước nào fail là dừng TRƯỚC khi
 * subprocess chạy (không có lệnh nào được thực thi nửa vời).
 */
export function putWorkerSecret(
  action: SecretAction,
  secretName: string,
  configPath: string,
  value: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: WorkerSecretDeps = defaultDeps,
): { worker: string; args: string[] } {
  // Type đã chặn caller TS; guard này cho caller runtime (argv, JS không type).
  if (action !== 'put' && action !== 'stage') {
    throw new Error(`unknown secret action "${action}" — expected "put" or "stage"`);
  }
  validateSecretName(secretName);
  if (trimTrailingNewline(value).length === 0) {
    throw new Error('secret value is empty — pipe a non-empty value via stdin');
  }
  const { env } = resolveSecretRunEnv(sourceEnv);
  // Resolve config path MỘT lần: cwd của wrangler là thư mục chứa config và
  // `--config` là đường tuyệt đối — relative path hoạt động từ mọi thư mục
  // gọi CLI, relative path trong config (schema, assets) cũng không vỡ.
  const configAbs = resolve(configPath);
  let configText: string;
  try {
    configText = deps.readTextFile(configAbs);
  } catch (error) {
    // Lỗi IO (ENOENT, permission…) ném tên path — operator nhìn là biết sửa gì,
    // không để stack raw nổ lên đường chạy CLI.
    throw new Error(
      `cannot read wrangler config at ${configAbs}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const worker = stagingWorkerNameFromConfig(configText);
  if (classifyWorkerName(worker) !== 'staging') {
    throw new Error(
      `resolved worker "${worker}" is not a staging identity (expected prefix "stg-") — ` +
        'refusing to write secrets outside the staging scope',
    );
  }
  const args = buildWranglerSecretArgs(action, secretName, configAbs);
  // Giá trị cho wrangler đã cắt newline cuối — 'echo value |' và printf phải
  // cho ra cùng một secret, bất kể cách pipe của operator. Chuỗi này ĐÚNG là
  // cái wrangler nhận qua stdin, nên cũng là khoá redaction chính.
  const payload = trimTrailingNewline(value);
  const result = deps.execFn('npx', ['wrangler', ...args], dirname(configAbs), env, {
    input: payload,
  });
  if (result.status !== 0) {
    const rawReason =
      result.error?.message ??
      (result.signal !== undefined && result.signal !== null
        ? `killed by signal ${result.signal}`
        : result.stderr.trim() === ''
          ? 'no output'
          : result.stderr.trim());
    // Lớp redaction rẻ: stderr là text third-party (wrangler/Cloudflare API) —
    // nếu một version sau echo giá trị stdin vào error text thì giá trị gốc
    // không được phép lọt ra log. Redact BA form — payload đúng cái vào stdin,
    // value thô, và payload.trim() vì rawReason trim stderr (mất whitespace
    // biên của payload khi nó nằm cuối stderr). Bỏ qua khi payload chỉ toàn
    // whitespace để replaceAll không biến mọi ký tự thành marker.
    let reason = rawReason;
    if (payload.trim() !== '') {
      for (const key of [payload, value, payload.trim()]) {
        if (key !== '') reason = reason.replaceAll(key, '[redacted]');
      }
    }
    throw new Error(`wrangler ${action} ${secretName} on ${worker} failed: ${reason}`);
  }
  return { worker, args };
}
