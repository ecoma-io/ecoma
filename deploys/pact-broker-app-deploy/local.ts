/**
 * Entry lifecycle local của `pact-broker-app-deploy` — `up`/`down` trên stack
 * Pulumi của CHÍNH project này; thứ tự toàn cục do Nx suy từ `dependsOn` của
 * package.json (app chạy sau api vì đọc machine token cross-stack từ stack
 * api).
 *
 * Chạy qua target Nx: `nx run pact-broker-app-deploy:local-up -c local` →
 * `npx tsx local.ts up`. Entry KHÔNG lấy khóa lane nào: lifecycle không có
 * khóa toàn cục (quyết định kiến trúc PR #424).
 *
 * Secret bảng của app (BFF dashboard): `apiToken` là ĐỌC LẠI từ stack config
 * của `pact-broker-api-deploy` (`machineToken` — api đã persist khi up trước
 * đó theo dependsOn). BFF giữ plaintext làm `NITRO_PACT_BROKER_API_TOKEN` để
 * gọi API; api seed HASH SHA-256 vào DB. Một giá trị chia hai stack — cùng cơ
 * chế với secret auth<->account và account<->mail.
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import {
  deployProjectDir,
  ensureStackForEntry,
  exec,
  fullStackRef,
  pulumiDestroyForEntry,
  pulumiUpForEntry,
  resolveEntryFoundation,
  setStackConfig,
  type EntryFoundation,
} from '@ecoma-io/deployment';

/**
 * Machine token plaintext dùng chung pact-broker-api <-> pact-broker-app —
 * ĐỌC LẠI từ stack config của api.
 *
 * Stack api (chạy trước theo dependsOn) SINH token mới và persist vào stack
 * config của chính nó (`namespace:machineToken`); app đọc lại để BFF gọi API
 * bằng đúng token mà api đã seed hash vào DB.
 */
function resolvePactApiMachineToken(foundation: EntryFoundation): string {
  const read = exec(
    'pulumi',
    [
      'config',
      'get',
      'namespace:machineToken',
      '--stack',
      fullStackRef('pact-broker-api-deploy', foundation.ctx),
    ],
    deployProjectDir('pact-broker-api-deploy'),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) {
    return read.stdout.trim();
  }
  // Cùng luật không-leak: raw stdout của `config get` khi exit 0 chính là
  // machine token — không bao giờ ghép vào error string.
  console.error(
    '[pact-broker-app-deploy] up: reading namespace:machineToken from the ' +
      `pact-broker-api-deploy stack failed (exit ${String(read.status)}) — ` +
      'pact-broker-api-deploy up must run BEFORE pact-broker-app-deploy (dependsOn). ' +
      'Run `pulumi config get namespace:machineToken --stack <pact-broker-api-stack-ref>` ' +
      'in deploys/pact-broker-api-deploy to see the original stderr — the output of that ' +
      'command is never logged because it may contain the secret.',
  );
  process.exit(1);
}

async function prepare(foundation: EntryFoundation): Promise<void> {
  // Stack phải tồn tại trước khi `config set` — lần up đầu trên worktree mới,
  // state dir chưa có và mọi lệnh config exit 1 (xem `ensureStackForEntry`).
  // Đọc cross-stack machineToken của api stack KHÔNG cần bước này: api up chạy
  // trước theo dependsOn nên stack của nó đã có.
  ensureStackForEntry('pact-broker-app-deploy', foundation);
  const apiToken = resolvePactApiMachineToken(foundation);
  setStackConfig('pact-broker-app-deploy', 'namespace:apiToken', apiToken, foundation);
}

async function main(command: string): Promise<number> {
  if (command === 'up') {
    const foundation = resolveEntryFoundation(true);
    if (foundation === undefined) {
      return 1;
    }
    try {
      await prepare(foundation);
      pulumiUpForEntry('pact-broker-app-deploy', foundation);
    } catch (error) {
      console.error(
        `[pact-broker-app-deploy] up failed: ${error instanceof Error ? error.message : String(error)}`,
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
        '[pact-broker-app-deploy] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      pulumiDestroyForEntry('pact-broker-app-deploy', foundation);
      return 0;
    } catch (error) {
      console.error(
        `[pact-broker-app-deploy] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[pact-broker-app-deploy] unknown command: ${command} (expected: up | down)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
