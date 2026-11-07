/**
 * Entry lifecycle local của `push-notification-deploy` — `up`/`down` trên
 * stack Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn`
 * của package.json (push phụ thuộc platform cho network/DB platform).
 *
 * Chạy qua target Nx: `nx run push-notification-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Cả BỐN secret là CỦA RIÊNG cặp push local (không stack nào khác đọc): hai
 * process của cặp sống trong MỘT container WIC nên entry cấp ĐỒNG BỘ giá trị
 * mới trong CÙNG một lần up — không cần persistence cross-stack.
 * `runtimeSharedSecret` đi vào CẢ HAI worker (control plane
 * `RUNTIME_API_SHARED_SECRET` + consumer cùng biến, hai env NAME một giá trị);
 * `credentialRootKey` là base64 của 32 byte AES-256 (mà `buildCipher` kiểm) —
 * xoay mỗi lần up là vô hại vì D1 `push` trên volume state là ephemeral theo
 * thiết kế local (không credential nào sống qua hai lần up).
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import {
  ensureStackForEntry,
  generateInternalHmacSecret,
  pulumiDestroyForEntry,
  pulumiUpForEntry,
  resolveEntryFoundation,
  setStackConfig,
  type EntryFoundation,
} from '@ecoma-io/deployment';

import { generateBase64Key32 } from './local-generators.js';

async function prepare(foundation: EntryFoundation): Promise<void> {
  // Stack phải tồn tại trước khi `config set` — lần up đầu trên worktree mới,
  // state dir chưa có và mọi lệnh config exit 1 (xem `ensureStackForEntry`).
  ensureStackForEntry('push-notification-deploy', foundation);
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ['namespace:runtimeSharedSecret', generateInternalHmacSecret()],
    ['namespace:adminToken', generateInternalHmacSecret()],
    ['namespace:applicationToken', generateInternalHmacSecret()],
    ['namespace:credentialRootKey', generateBase64Key32()],
  ];
  for (const [configKey, configValue] of secrets) {
    setStackConfig('push-notification-deploy', configKey, configValue, foundation);
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
      pulumiUpForEntry('push-notification-deploy', foundation);
    } catch (error) {
      console.error(
        `[push-notification-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
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
        '[push-notification-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('push-notification-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[push-notification-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[push-notification-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
