/**
 * Entry lifecycle local của `transactional-mail-deploy` — `up`/`down` trên
 * stack Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn`
 * của package.json (mail chạy sau account vì đọc secret cross-stack từ stack
 * account).
 *
 * Chạy qua target Nx: `nx run transactional-mail-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Secret bảng của mail:
 * - `mailInternalAuthSecret`: ĐỌC LẠI từ stack config của account (account đã
 *   persist khi up trước đó theo dependsOn) — receiver mail giữ nó làm entry
 *   `MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT` của credential registry, account
 *   ký envelope với cùng giá trị đó.
 * - Ba secret còn lại là CỦA RIÊNG cặp mail local (không stack nào khác đọc):
 *   `mailerJobInternalSecret` (HMAC consumer<->control plane),
 *   `mailFingerprintKey` + `mailQuarantineHmacKey` (khoá keyring fingerprint,
 *   khoá quarantine — hình 64 hex chữ thường là contract loader). Sinh tại
 *   chỗ mỗi lần up: hai process của cặp nhận ĐỒNG BỘ giá trị mới trong CÙNG
 *   một lần up nên không bao giờ lệch nhau (cùng chu kỳ xoay với
 *   `otpHmacSecret`, `cookieKeys`).
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import {
  deployProjectDir,
  ensureStackForEntry,
  exec,
  fullStackRef,
  generateInternalHmacSecret,
  pulumiDestroyForEntry,
  pulumiUpForEntry,
  resolveEntryFoundation,
  setStackConfig,
  type EntryFoundation,
} from '@ecoma-io/deployment';

import { generateHexKey64 } from './local-generators.js';

/**
 * Giá trị HMAC dùng chung account <-> transactional-mail — ĐỌC LẠI từ stack
 * config của account.
 *
 * Account (chạy trước theo dependsOn) SINH giá trị mới và persist vào stack
 * config của chính nó (`namespace:mailInternalAuthSecret`); mail đọc lại để
 * hai stack nhận đúng MỘT giá trị.
 */
function resolveMailInternalAuthSecret(foundation: EntryFoundation): string {
  const read = exec(
    'pulumi',
    [
      'config',
      'get',
      'namespace:mailInternalAuthSecret',
      '--stack',
      fullStackRef('account-deploy', foundation.ctx),
    ],
    deployProjectDir('account-deploy'),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) {
    return read.stdout.trim();
  }
  // Cùng luật không-leak với nhánh auth: raw stdout của `config get` khi exit 0
  // chính là secret — không bao giờ ghép vào error string.
  console.error(
    '[transactional-mail-deploy] up: reading namespace:mailInternalAuthSecret from the ' +
      `account-deploy stack failed (exit ${String(read.status)}) — account up must run ` +
      'BEFORE transactional-mail-deploy (dependsOn). Run `pulumi config get ' +
      'namespace:mailInternalAuthSecret --stack <account-stack-ref>` in ' +
      'deploys/account-deploy to see the original stderr — the output of that command is ' +
      'never logged because it may contain the secret.',
  );
  process.exit(1);
}

async function prepare(foundation: EntryFoundation): Promise<void> {
  // Stack phải tồn tại trước khi `config set` — lần up đầu trên worktree mới,
  // state dir chưa có và mọi lệnh config exit 1 (xem `ensureStackForEntry`).
  // Đọc cross-stack mailInternalAuthSecret của account stack KHÔNG cần bước
  // này: account up chạy trước theo dependsOn nên stack của nó đã có.
  ensureStackForEntry('transactional-mail-deploy', foundation);
  const mailInternalAuthSecret = resolveMailInternalAuthSecret(foundation);
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ['namespace:mailInternalAuthSecret', mailInternalAuthSecret],
    ['namespace:mailerJobInternalSecret', generateInternalHmacSecret()],
    ['namespace:mailFingerprintKey', generateHexKey64()],
    ['namespace:mailQuarantineHmacKey', generateHexKey64()],
  ];
  for (const [configKey, configValue] of secrets) {
    setStackConfig('transactional-mail-deploy', configKey, configValue, foundation);
  }
}

async function main(command: string): Promise<number> {
  if (command === 'up') {
    const foundation = resolveEntryFoundation(true);
    if (foundation === undefined) {
      return 1;
    }
    try {
      await prepare(foundation);
      pulumiUpForEntry('transactional-mail-deploy', foundation);
    } catch (error) {
      console.error(
        `[transactional-mail-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
    // Readiness đã thuộc container resource (`wait: true` trong index.ts):
    // `pulumi up` xanh đồng nghĩa healthcheck Docker của unit đã `healthy` —
    // DX không biết Docker health tồn tại.
    return 0;
  }
  if (command === 'down') {
    const foundation = resolveEntryFoundation(false);
    if (foundation === undefined) {
      console.log(
        '[transactional-mail-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('transactional-mail-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[transactional-mail-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[transactional-mail-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
