/**
 * Smoke real-storage của `remote-cache-api-deploy` — outer (host).
 *
 * Chạy qua target Nx: `nx run remote-cache-api-deploy:local-smoke -c local` →
 * `npx tsx smoke.ts`. Prerequisite duy nhất là `local-up` của CHÍNH unit này
 * (platform đã lên trước theo `dependsOn` của `local-up`); smoke là node LÁ —
 * không unit nào phụ thuộc nó.
 *
 * Mục đích: chứng minh ĐƯỜNG STORAGE THẬT sau khi `local-up`, qua BỐN mắt:
 * 1. `GET /ready` của worker phải báo `database: 'ok'` VÀ
 *    `storage: 'configured'` — bốn biến env `S3_*` đã đến tay worker qua
 *    kênh `envs` của WIC và `config.ts` của app nạp được bộ config đó (con
 *    đường qua code thật của app).
 * 2. Client S3 THẬT của app (`apps/remote-cache-api/src/storage.ts`, class
 *    `S3ObjectStorage`) round-trip trên bucket SeaweedFS của platform (chạy
 *    TRONG container gắn platform network — object store không publish host
 *    port): `putIfAbsent` → `'created'`, `get` byte-equal, `putIfAbsent` lần
 *    hai → `'exists'`, `get` key chưa viết → `null`. Inner nằm CÙNG app
 *    (`apps/remote-cache-api/smoke/smoke-inner.mts`) để import được class thật:
 *    ranh giới module cấm `deploy → composition`, còn composition tự import
 *    chính nó là hợp lệ (quyết định coordinator, follow-up của slice này).
 * 3. Cleanup KHÔNG thêm op delete vào port của app: smoke tự ký MỘT request
 *    S3 DELETE SigV4 (inner), assert 2xx, rồi `get` lại → `null`.
 * 4. Exit 0 CHỈ khi mọi assertion giữ; dòng log PASS/FAIL là tiếng Anh, giữ
 *    nguyên cho evidence.
 *
 * Secret đi QUA STDIN: outer đọc `namespace:objectStorageSecretKey` từ stack
 * config của chính unit (đã được `local.ts` copy từ platform khi up) rồi
 * truyền cho inner qua fd 0 của `docker run -i` — KHÔNG qua argv, KHÔNG qua
 * `-e` (giá trị `-e` của docker nằm trong `ps` của host), KHÔNG qua label/log.
 * Inner đọc stdin tới EOF và không bao giờ in giá trị; outer chỉ in captured
 * stdout/stderr của inner — vốn không chứa secret.
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output của smoke gate (nx:run-commands gộp stdout/stderr).

import { join } from 'node:path';

import {
  deployProjectDir,
  describeSpawnFailure,
  exec,
  fullStackRef,
  pulumiRun,
  resolveEntryFoundation,
  type EntryFoundation,
} from '@ecoma-io/deployment';

import { NODE_IMAGE } from './node-image.js';
import { buildObjectStorageEnvs, type ObjectStorageEnvName } from './object-storage-env.js';

const PROJECT = 'remote-cache-api-deploy';
const PLATFORM_PROJECT = 'platform-deploy';

/** Key stack config của CHÍNH unit chứa secret key object storage. */
const OWN_SECRET_CONFIG_KEY = 'namespace:objectStorageSecretKey';

/** Root của workspace, suy từ vị trí file này (`deploys/remote-cache-api-deploy`). */
const WORKSPACE_ROOT = join(import.meta.dirname, '../..');

/** Đường dẫn inner trong repo mount — `-w /repo` nên path tương đối với /repo.
 *  Inner nằm CÙNG app để import được class `S3ObjectStorage` thật (ranh giới
 *  module cấm deploy → composition; xem JSDoc của inner). */
const INNER_SCRIPT = 'apps/remote-cache-api/smoke/smoke-inner.mts';

/** Đầu vào mà outer thu thập trước khi spawn container smoke. */
interface SmokeInputs {
  readonly networkName: string;
  readonly objectStorageEnvs: Readonly<Record<ObjectStorageEnvName, string>>;
}

/**
 * Đọc outputs của platform stack (`pulumi stack output --json`, cùng cơ chế
 * `readPlatformOutputs` của platform-deploy) và kiểm fail-closed từng key —
 * outputs là non-secret theo contract nên giá trị lệch được in vào message.
 */
function readPlatformSmokeInputs(foundation: EntryFoundation): SmokeInputs {
  const stdout = pulumiRun(
    deployProjectDir(PLATFORM_PROJECT),
    PLATFORM_PROJECT,
    ['stack', 'output', '--json'],
    foundation.ctx,
    foundation.env,
    { prepareStack: false },
  );
  let outputs: Record<string, unknown>;
  try {
    outputs = JSON.parse(stdout ?? '') as Record<string, unknown>;
  } catch {
    throw new Error(
      'Failed to parse platform stack outputs as JSON — has `pnpm nx run platform-deploy:local-up -c local` run yet?',
    );
  }
  const networkName = outputs['networkName'];
  if (typeof networkName !== 'string' || networkName.length === 0) {
    throw new Error(
      `Platform stack does not export a usable "networkName" (got ${JSON.stringify(networkName)}) — run \`pnpm nx run platform-deploy:local-up -c local\` first.`,
    );
  }
  const host = outputs['objectStorageHost'];
  const port = outputs['objectStoragePort'];
  const bucket = outputs['objectStorageBucket'];
  const accessKeyId = outputs['objectStorageAccessKeyId'];
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error(
      `Platform stack does not export a usable "objectStorageHost" (got ${JSON.stringify(host)}) — re-run platform up (object store, #19).`,
    );
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      `Platform stack does not export a usable "objectStoragePort" (got ${JSON.stringify(port)}) — re-run platform up (object store, #19).`,
    );
  }
  if (typeof bucket !== 'string' || bucket.length === 0) {
    throw new Error(
      `Platform stack does not export a usable "objectStorageBucket" (got ${JSON.stringify(bucket)}) — re-run platform up (object store, #19).`,
    );
  }
  if (typeof accessKeyId !== 'string' || accessKeyId.length === 0) {
    throw new Error(
      `Platform stack does not export a usable "objectStorageAccessKeyId" (got ${JSON.stringify(accessKeyId)}) — re-run platform up (object store, #19).`,
    );
  }
  return {
    networkName,
    objectStorageEnvs: buildObjectStorageEnvs({ host, port, bucket, accessKeyId }),
  };
}

/**
 * Đọc lại secret key object storage từ stack config của CHÍNH unit — outer
 * smoke KHÔNG đọc cross-stack (giá trị đã được `local.ts` copy khi up, cùng
 * pattern persist của các secret khác).
 *
 * KHÔNG nhúng raw stdout/stderr vào log: stdout của `pulumi config get` khi
 * exit 0 CHÍNH LÀ secret. Thông điệp cố định + hướng dẫn tự chạy lệnh.
 */
function readOwnObjectStorageSecret(foundation: EntryFoundation): string {
  const read = exec(
    'pulumi',
    ['config', 'get', OWN_SECRET_CONFIG_KEY, '--stack', fullStackRef(PROJECT, foundation.ctx)],
    deployProjectDir(PROJECT),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) {
    return read.stdout.trim();
  }
  console.error(
    `[${PROJECT}] smoke: reading ${OWN_SECRET_CONFIG_KEY} from the own stack failed (exit ` +
      String(read.status) +
      ') — local-up must run BEFORE local-smoke (dependsOn). Run `pulumi config get ' +
      OWN_SECRET_CONFIG_KEY +
      ' --stack <stack-ref>` in deploys/' +
      PROJECT +
      ' to see the original stderr — the output of that command is never logged because it may contain ' +
      'the secret.',
  );
  process.exit(1);
}

/**
 * Spawn container smoke: ephemeral, gắn platform network, repo mount READ-ONLY,
 * image Node pin CÙNG digest với WIC/migration (`node-image.ts`). Ba env
 * non-secret qua `-e` (giá trị nằm trong argv của host — chấp nhận được vì
 * chúng là outputs non-secret); secret đi QUA STDIN (`input` của exec) —
 * docker argv của host (`ps`) thấy được mọi `-e` value, nên secret KHÔNG BAO
 * GIỜ đi qua đó. Inner đọc fd 0 tới EOF.
 */
function runInnerSmoke(inputs: SmokeInputs, secret: string, worktreeRoot: string): number {
  const args = [
    'run',
    '--rm',
    '-i',
    '--network',
    inputs.networkName,
    '-e',
    `S3_ENDPOINT=${inputs.objectStorageEnvs.S3_ENDPOINT}`,
    '-e',
    `S3_BUCKET=${inputs.objectStorageEnvs.S3_BUCKET}`,
    '-e',
    `S3_ACCESS_KEY_ID=${inputs.objectStorageEnvs.S3_ACCESS_KEY_ID}`,
    '-v',
    `${worktreeRoot}:/repo:ro`,
    '-w',
    '/repo',
    NODE_IMAGE,
    'npx',
    'tsx',
    INNER_SCRIPT,
  ];
  const result = exec('docker', args, WORKSPACE_ROOT, process.env, { input: secret });
  if (result.status === null) {
    console.error(`[${PROJECT}] smoke: docker could not run: ${describeSpawnFailure(result)}`);
    return 1;
  }
  if (result.status !== 0) {
    // Inner được viết để output không bao giờ chứa secret — in đầy đủ để debug.
    console.error(
      `[${PROJECT}] smoke FAILED (inner exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
    );
    return result.status;
  }
  console.log(result.stdout.trimEnd());
  console.log(`[${PROJECT}] smoke OK: real storage path verified end to end.`);
  return 0;
}

async function main(): Promise<number> {
  // `create: false` — smoke KHÔNG tạo state: worktree chưa từng deploy là fail
  // có hướng dẫn (smoke đo unit đã lên, không phải bootstrap state mới).
  const foundation = resolveEntryFoundation(false);
  if (foundation === undefined) {
    console.error(
      `[${PROJECT}] smoke: this worktree has never deployed (no .pulumi-local-state) — run local-up first.`,
    );
    return 1;
  }
  try {
    const inputs = readPlatformSmokeInputs(foundation);
    const secret = readOwnObjectStorageSecret(foundation);
    return runInnerSmoke(inputs, secret, foundation.ctx.worktreeRoot);
  } catch (error) {
    console.error(
      `[${PROJECT}] smoke failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

main().then((code) => (process.exitCode = code));
