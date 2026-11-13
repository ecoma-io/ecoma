/**
 * Entry lane E2E của `llm-api-deploy` — `up`/`down`/`state` hội tụ hạ tầng mà
 * suite `system-tests/e2e/llm-inference-e2e` tiêu thụ (Issues #23/#24). Suite
 * KHÔNG BAO GIỜ đụng vòng đời container mock: toàn bộ lifecycle thuộc target
 * `test-lane-up`/`test-lane-down` của unit này, đúng ranh giới trong README.
 *
 * `up` hội tụ BỐN thứ, đúng thứ tự:
 * 1. credential upstream set-if-absent (`namespace:llmUpstreamCredentialPlaintext`)
 *    và endpoint URL ghi đè về mock nội bộ (DNS + đường chat completions —
 *    worker POST endpoint URL nguyên vẹn) — giá trị CHỈ đi qua kênh stdin
 *    của `pulumi config set` (`setStackConfig`), không bao giờ argv;
 * 2. container mock `ecoma-<ns>-llm-upstream-mock` trên platform network, image
 *    pin digest, repo mount read-only, credential qua env của PROCESS docker
 *    (argv chỉ mang TÊN biến — builder ở module thuần `lane-invocation.ts`);
 * 3. readiness mock qua MỘT container waiter ephemeral trong network (probe
 *    `GET /v1/models` kèm Authorization đúng, retry trong budget) — DX không
 *    poll Docker health, và probe phải đi TRONG network vì mock không publish
 *    cổng ra host;
 * 4. `local.ts up` của CHÍNH unit — hoặc BỎ QUA khi stack đã hội tụ (xuống đây).
 *
 * Skip-converged (bước 4): `local.ts up` xoay sáu mật khẩu role ở MỌI lần chạy
 * → migrate chạy lại → command bootstrap bước 9 chạy lại → stdout ghi nhận
 * (recorded stdout) bị THAY THẾ mà KHÔNG còn plaintext (runner hội tụ: key tồn
 * tại → `outcome: 'existing'` → không in plaintext — show-once). Nên khi stack
 * output `consumerApiKeyStdout` đã mang dòng `ECOMA_CONSUMER_API_KEY=` thì
 * `up` SKIP `local.ts up` nguyên vòng: giữ nguyên plaintext trong state, giữ
 * nguyên đúng-một-row api_keys, và lane thứ hai trở đi chạy nhanh.
 *
 * Kênh secret của entry này (luật không-leak):
 * - credential upstream: env của process docker (argv name-only) và stdin của
 *   `pulumi config set`; không argv, không log, không stdout.
 * - plaintext API key consumer: CHỈ đọc từ stack output bí mật
 *   `consumerApiKeyStdout` (`--show-secrets`) và CHỈ đi ra trong envelope
 *   `LANE_STATE=` của lệnh `state` — stdout mà runner suite bắt để parse rồi
 *   KHÔNG forward. Mọi đường lỗi nêu exit code + lệnh chạy tay, KHÔNG ghép raw
 *   output vào message.
 * - stdout của tiến trình con `local.ts up` bị GIỮ (không forward): run tạo
 *   key in plaintext qua chuỗi pulumi → withheld, lấy lại từ stack output.
 *
 * Hạn chế đã biết: plaintext mất khi state Pulumi bị xoá mà database còn giữ
 * row key (runner sẽ hội tụ `existing` và không bao giờ in lại) — phục hồi bằng
 * xoá row `api_keys` hoặc `local-down` đầy đủ rồi `test-lane-up` lại. Khi đó
 * `up` fail-closed với hướng dẫn, KHÔNG đoán key.
 */
// oxlint-disable no-console -- entry CLI chạy trên Node; console là kênh
// output DUY NHẤT của lifecycle gate (nx:run-commands gộp stdout/stderr).

import { spawnSync } from 'node:child_process';

import {
  deployProjectDir,
  describeSpawnFailure,
  ensureStackForEntry,
  exec,
  fullStackRef,
  generatePostgresPassword,
  isConfigKeyMissing,
  resolveEntryFoundation,
  setStackConfig,
  type EntryFoundation,
  type ExecResult,
} from '@ecoma-io/deployment';

// Module thuần túy dựng argv + parser stdout — entry này chỉ orchestrate; spec
// colocated import THẰNG module đó (entry tự chạy `main()` lúc load, cùng lý
// do `superadmin-resolver.ts` tách khỏi `local.ts`).
import {
  MOCK_WAIT_BUDGET_MS,
  buildLaneStateLine,
  buildMockContainerInvocation,
  buildMockWaiterInvocation,
  extractConsumerApiKeyRecordedStdout,
  hasConsumerApiKeyLine,
  mockContainerName,
  mockUpstreamBaseUrl,
  mockUpstreamEndpointUrl,
} from './lane-invocation.js';

/** Stack project của unit này — mọi lệnh pulumi config/output dùng đúng nó. */
const LANE_PROJECT = 'llm-api-deploy';

/** Config key base URL upstream — `up` ghi đè về mock DNS nội bộ (không secret). */
const UPSTREAM_BASE_URL_CONFIG_KEY = 'namespace:llmUpstreamBaseUrl';

/** Config key credential upstream — set-if-absent, giá trị qua stdin channel. */
const UPSTREAM_CREDENTIAL_CONFIG_KEY = 'namespace:llmUpstreamCredentialPlaintext';

/** Config key owner sub của tenant consumer — đọc cho envelope `state`. */
const TENANT_OWNER_SUB_CONFIG_KEY = 'namespace:tenantOwnerSub';

/** Tên stack output mang stdout ghi nhận của bước 9 (secret — xem index.ts). */
const CONSUMER_API_KEY_OUTPUT_NAME = 'consumerApiKeyStdout';

/**
 * Đọc một giá trị stack config — trả `undefined` khi key chưa có, throw khi
 * đọc lỗi vì lý do khác. Bản sao chữ-số-chữ của helper trong `local.ts`: KHÔNG
 * import được vì entry đó tự chạy `main()` lúc load. Raw output không bao giờ
 * vào message.
 */
function readStackConfig(foundation: EntryFoundation, configKey: string): string | undefined {
  const read = exec(
    'pulumi',
    ['config', 'get', configKey, '--stack', fullStackRef(LANE_PROJECT, foundation.ctx)],
    deployProjectDir(LANE_PROJECT),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) return read.stdout.trim();
  if (read.status === 0 || isConfigKeyMissing(read)) return undefined;
  throw new Error(
    `reading ${configKey} failed (exit ${String(read.status)}) — ` +
      `run \`pulumi config get ${configKey} --stack ${fullStackRef(LANE_PROJECT, foundation.ctx)}\` in ${deployProjectDir(LANE_PROJECT)} to see the original stderr`,
  );
}

/**
 * "Chưa có output" của `pulumi stack output` — CHỈ khi CLI báo đúng vậy.
 *
 * `up` ĐẦU TIÊN của stack chưa từng chạy `local.ts up` nên output
 * `consumerApiKeyStdout` chưa tồn tại: exit 1 kèm đúng thông điệp này là đường
 * "chưa hội tụ" phải trả `undefined` để `up` đi tiếp, KHÔNG phải lỗi. Exit != 0
 * vì lý do khác (sai passphrase, state lock, backend hỏng) phải tiếp tục ném —
 * nuốt nhầm là `up` tự nghĩ chưa hội tụ rồi đè state đang khoá plaintext.
 * So khớp chuỗi con bằng indexOf thay vì regex `.*` cùng lý do CodeQL RedDoS
 * như `isConfigKeyMissing` của libs (helper này là bản địa phương — libs nằm
 * ngoài phạm vi slice này).
 */
function isStackOutputMissing(result: ExecResult): boolean {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const marker = output.indexOf('does not have output property');
  return marker !== -1 && output.includes('consumerapikeystdout', marker);
}

/** Đọc stdout ghi nhận của stack output key — `undefined` khi output chưa có. */
function readConsumerApiKeyStackOutput(foundation: EntryFoundation): string | undefined {
  const read = exec(
    'pulumi',
    [
      'stack',
      'output',
      CONSUMER_API_KEY_OUTPUT_NAME,
      '--stack',
      fullStackRef(LANE_PROJECT, foundation.ctx),
      '--show-secrets',
    ],
    deployProjectDir(LANE_PROJECT),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) return read.stdout;
  if (read.status === 0 || isStackOutputMissing(read)) return undefined;
  throw new Error(
    `reading stack output ${CONSUMER_API_KEY_OUTPUT_NAME} failed (exit ${String(read.status)}) — ` +
      `run \`pulumi stack output ${CONSUMER_API_KEY_OUTPUT_NAME} --stack ${fullStackRef(LANE_PROJECT, foundation.ctx)} --show-secrets\` in ${deployProjectDir(LANE_PROJECT)} to see the original stderr`,
  );
}

/** Tên platform network từ output `networkName` của stack platform — fail-closed. */
function readPlatformNetwork(foundation: EntryFoundation): string {
  const read = exec(
    'pulumi',
    ['stack', 'output', 'networkName', '--stack', fullStackRef('platform-deploy', foundation.ctx)],
    deployProjectDir('platform-deploy'),
    foundation.env,
  );
  if (read.status === 0 && read.stdout.trim().length > 0) return read.stdout.trim();
  throw new Error(
    `reading platform output networkName failed (exit ${String(read.status)}): ${read.stderr}`,
  );
}

/**
 * Chạy `npx tsx local.ts up` của CHÍNH unit với stdout GIỮ (run tạo key in
 * plaintext qua chuỗi pulumi — không được chạm captured artifact nào). stderr
 * inherit để tiến trình chuẩn bị + pulumi vẫn báo tiến trình sống. Lỗi child:
 * nêu exit + hướng dẫn chạy tay, KHÔNG ghép stdout vào message.
 */
function runLaneUp(foundation: EntryFoundation): void {
  const child = spawnSync('npx', ['tsx', 'local.ts', 'up'], {
    cwd: deployProjectDir(LANE_PROJECT),
    encoding: 'utf8',
    env: foundation.env,
    // stdout pipe (giữ, không forward) — stderr inherit (tiến trình sống).
    stdio: ['inherit', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error !== undefined && child.error !== null) {
    throw new Error(`starting local.ts up failed: ${child.error.message}`);
  }
  if (child.signal !== undefined && child.signal !== null) {
    throw new Error(`local.ts up was killed by signal: ${String(child.signal)}`);
  }
  if (child.status !== 0) {
    throw new Error(
      `local.ts up failed with exit ${String(child.status)}; its stdout is withheld because the creating run prints the consumer API key plaintext — ` +
        `re-run \`npx tsx local.ts up\` manually from ${deployProjectDir(LANE_PROJECT)} if you need to see it`,
    );
  }
}

/** Một bước hội tụ của `up` — trả tên container (log stderr, không secret). */
function convergeMockContainer(
  foundation: EntryFoundation,
  networkName: string,
  expectedAuthorization: string,
): string {
  const name = mockContainerName(foundation.ctx.namespace);
  const rm = exec('docker', ['rm', '-f', name], foundation.ctx.worktreeRoot, foundation.env);
  if (rm.error !== undefined) {
    throw new Error(`removing a previous mock container failed: ${describeSpawnFailure(rm)}`);
  }
  if (rm.status !== 0 && !/no such container/iu.test(rm.stderr)) {
    throw new Error(
      `removing a previous mock container failed (exit ${String(rm.status)}): ${rm.stderr}`,
    );
  }
  const invocation = buildMockContainerInvocation({
    namespace: foundation.ctx.namespace,
    networkName,
    worktreeRoot: foundation.ctx.worktreeRoot,
    expectedAuthorization,
  });
  const run = exec('docker', invocation.args, foundation.ctx.worktreeRoot, {
    ...foundation.env,
    ...invocation.env,
  });
  if (run.error !== undefined) {
    throw new Error(`starting the mock upstream container failed: ${describeSpawnFailure(run)}`);
  }
  if (run.status !== 0) {
    throw new Error(
      `starting the mock upstream container failed (exit ${String(run.status)}): ${run.stderr}`,
    );
  }
  return name;
}

/** Chờ mock phục vụ `GET /v1/models` kèm auth đúng — MỘT container waiter. */
function awaitMockReadiness(
  foundation: EntryFoundation,
  networkName: string,
  expectedAuthorization: string,
): void {
  const name = mockContainerName(foundation.ctx.namespace);
  const invocation = buildMockWaiterInvocation({
    networkName,
    mockUrl: mockUpstreamBaseUrl(foundation.ctx.namespace),
    budgetMs: MOCK_WAIT_BUDGET_MS,
    expectedAuthorization,
  });
  const result = exec('docker', invocation.args, foundation.ctx.worktreeRoot, {
    ...foundation.env,
    ...invocation.env,
  });
  if (result.error !== undefined) {
    throw new Error(`starting the mock readiness waiter failed: ${describeSpawnFailure(result)}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `mock upstream did not serve GET /v1/models within ${String(MOCK_WAIT_BUDGET_MS / 1000)}s — ` +
        `inspect \`docker logs ${name}\` before re-running`,
    );
  }
}

async function up(foundation: EntryFoundation): Promise<number> {
  // Stack phải tồn tại trước khi config get/set — lần đầu trên worktree mới
  // state dir chưa có (cùng thứ tự `prepare()` của `local.ts`).
  ensureStackForEntry(LANE_PROJECT, foundation);
  const networkName = readPlatformNetwork(foundation);

  // Credential upstream set-if-absent: đã có (từ `local.ts up` trước đó hoặc
  // lane trước) → GIỮ NGUYÊN — xoay là xoay credential row trong
  // provider_credentials (revoke cũ, thêm mới), chỉ chủ đích của người chạy.
  let credential = readStackConfig(foundation, UPSTREAM_CREDENTIAL_CONFIG_KEY);
  if (credential === undefined) {
    credential = generatePostgresPassword();
    setStackConfig(LANE_PROJECT, UPSTREAM_CREDENTIAL_CONFIG_KEY, credential, foundation);
    console.error('[llm-api-deploy-lane] generated a new upstream credential (set-if-absent)');
  }
  // Endpoint URL: lane SỞ HỮU serving cho E2E — ghi đè về endpoint đầy đủ của
  // mock mỗi lần up. Worker POST endpoint URL đã đăng ký NGUYÊN VẸN (không ghép
  // path — `apps/llm-api/src/chat-completions.ts` dùng `endpoint.url` thẳng)
  // nên giá trị PHẢI mang đường chat; probe 8b suy models từ cùng giá trị và
  // mock match hậu tố (README mock) nên probe vẫn chạm models. Giá trị không
  // secret. LƯU Ý đổi giá trị: bootstrap coi endpoint target là BẤT BIẾN
  // (fail-closed khi diverge) — phục hồi bằng xoá row `upstream_endpoints` rồi
  // cho bootstrap chạy lại (xem README, mục Lane E2E).
  setStackConfig(
    LANE_PROJECT,
    UPSTREAM_BASE_URL_CONFIG_KEY,
    mockUpstreamEndpointUrl(foundation.ctx.namespace),
    foundation,
  );

  // Giá trị Authorization mà mock chấp nhận là header ĐẦY ĐỦ worker gửi —
  // `Bearer ${credential}` (dispatch ở `apps/llm-api/src/upstream.ts`). Gate
  // mock so sánh nguyên header nên composition `Bearer ` xảy ra đúng một chỗ.
  const expectedAuthorization = `Bearer ${credential}`;
  const containerName = convergeMockContainer(foundation, networkName, expectedAuthorization);
  console.error(`[llm-api-deploy-lane] mock upstream container running: ${containerName}`);
  awaitMockReadiness(foundation, networkName, expectedAuthorization);
  console.error('[llm-api-deploy-lane] mock upstream is serving inside the platform network');

  // Skip-converged: stack output đã mang plaintext key → mọi thứ hội tụ, và
  // chạy `local.ts up` thêm lần nữa CHỈ xoay password + thay stdout ghi nhận
  // (mất plaintext) — skip nguyên vòng.
  const recorded = readConsumerApiKeyStackOutput(foundation);
  if (recorded !== undefined && hasConsumerApiKeyLine(recorded)) {
    console.error(
      '[llm-api-deploy-lane] lane converged — skipping local.ts up (api key plaintext stays in stack state)',
    );
    return 0;
  }
  console.error(
    '[llm-api-deploy-lane] running local.ts up (first lane convergence; its stdout is withheld)',
  );
  runLaneUp(foundation);

  // Bằng chứng kết thúc: plaintext key giờ phải đọc được từ stack output.
  // Đây cũng là lần kiểm duy nhất cho edge "stack state mới, database cũ":
  // runner bước 9 hội tụ `existing` và KHÔNG BAO GIỜ in lại plaintext.
  const afterUp = readConsumerApiKeyStackOutput(foundation);
  if (afterUp === undefined) {
    throw new Error(
      `stack output ${CONSUMER_API_KEY_OUTPUT_NAME} is missing after local.ts up — ` +
        'the deploy program of this unit must export it (index.ts)',
    );
  }
  try {
    extractConsumerApiKeyRecordedStdout(afterUp);
  } catch {
    throw new Error(
      'local.ts up converged but the api key plaintext was never recorded: the step-9 runner converged to an existing api_keys row whose plaintext this stack state never saw — ' +
        'recover by deleting the row (docker exec psql on db-llm-gateway) or by a full local-down then test-lane-up again',
    );
  }
  console.error(
    '[llm-api-deploy-lane] lane up complete — consumer api key retrievable from stack state',
  );
  return 0;
}

function down(foundation: EntryFoundation): number {
  const name = mockContainerName(foundation.ctx.namespace);
  const rm = exec('docker', ['rm', '-f', name], foundation.ctx.worktreeRoot, foundation.env);
  if (rm.error !== undefined) {
    console.error(
      `[llm-api-deploy-lane] removing the mock container failed: ${describeSpawnFailure(rm)}`,
    );
    return 1;
  }
  if (rm.status !== 0 && !/no such container/iu.test(rm.stderr)) {
    console.error(
      `[llm-api-deploy-lane] removing the mock container failed (exit ${String(rm.status)}): ${rm.stderr}`,
    );
    return 1;
  }
  console.error(`[llm-api-deploy-lane] mock container removed: ${name}`);
  return 0;
}

/**
 * In envelope `LANE_STATE=<json>` ĐÚNG MỘT dòng lên stdout — kênh mà runner
 * suite (`bin/run-system-test.mjs`) bắt để parse rồi KHÔNG forward. Mọi log
 * người đọc đi stderr. Plaintext key đi qua đây đúng MỘT chỗ và không bao giờ
 * xuất hiện trong message lỗi.
 */
function state(foundation: EntryFoundation): number {
  const networkName = readPlatformNetwork(foundation);
  const tenantOwnerSub = readStackConfig(foundation, TENANT_OWNER_SUB_CONFIG_KEY);
  if (tenantOwnerSub === undefined) {
    console.error(
      `[llm-api-deploy-lane] stack config ${TENANT_OWNER_SUB_CONFIG_KEY} is missing — run test-lane-up first`,
    );
    return 1;
  }
  const recorded = readConsumerApiKeyStackOutput(foundation);
  if (recorded === undefined) {
    console.error(
      `[llm-api-deploy-lane] stack output ${CONSUMER_API_KEY_OUTPUT_NAME} is missing — run test-lane-up first`,
    );
    return 1;
  }
  let consumerApiKey: string;
  try {
    consumerApiKey = extractConsumerApiKeyRecordedStdout(recorded);
  } catch (error) {
    console.error(
      `[llm-api-deploy-lane] ${error instanceof Error ? error.message : String(error)} — run test-lane-up first`,
    );
    return 1;
  }
  process.stdout.write(
    `${buildLaneStateLine({
      namespace: foundation.ctx.namespace,
      networkName,
      tenantOwnerSub,
      consumerApiKey,
    })}\n`,
  );
  return 0;
}

async function main(command: string): Promise<number> {
  if (command === 'up') {
    const foundation = resolveEntryFoundation(true);
    if (foundation === undefined) {
      return 1;
    }
    try {
      return await up(foundation);
    } catch (error) {
      console.error(
        `[llm-api-deploy-lane] up failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  if (command === 'down') {
    const foundation = resolveEntryFoundation(false);
    if (foundation === undefined) {
      console.log(
        '[llm-api-deploy-lane] this worktree has never deployed (no .pulumi-local-state) — down is a no-op.',
      );
      return 0;
    }
    try {
      return down(foundation);
    } catch (error) {
      console.error(
        `[llm-api-deploy-lane] down failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  if (command === 'state') {
    // `create: false` — lệnh ĐỌC không được tạo passphrase file hay state dir
    // mới; worktree chưa deploy là lỗi thứ tự (chạy test-lane-up trước).
    const foundation = resolveEntryFoundation(false);
    if (foundation === undefined) {
      console.error(
        '[llm-api-deploy-lane] this worktree has never deployed — run test-lane-up before reading lane state',
      );
      return 1;
    }
    try {
      return state(foundation);
    } catch (error) {
      console.error(
        `[llm-api-deploy-lane] state failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 1;
    }
  }
  console.error(`[llm-api-deploy-lane] unknown command: ${command} (expected: up | down | state)`);
  return 1;
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
void main(command).then((code) => {
  process.exit(code);
});
