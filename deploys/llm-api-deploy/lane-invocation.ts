/**
 * Module THUẦN TÚY của lane E2E (`deploys/llm-api-deploy`): hằng + builder
 * argv Docker cho container mock upstream và container waiter readiness, cùng
 * parser stdout ghi nhận của bước 9 và builder envelope `LANE_STATE`. Không
 * I/O, không exec — phần impure (đọc stack config/output, chạy docker, spawn
 * `local.ts up`) nằm ở entry `lane.ts`, tương tự cặp `local.ts` +
 * `superadmin-resolver.ts`: entry tự chạy `main()` lúc load nên spec colocated
 * chỉ được import module này, không import entry.
 *
 * Hai fence được module này giữstructural (spec colocated chấm):
 * - credential KHÔNG nằm trong argv của process Docker nào — argv chỉ mang
 *   TÊN biến pass-through `-e TÊN`; giá trị sống trong env của process CLI
 *   (đọc được qua `/proc/<pid>/cmdline` nên argv là kênh cấm — cùng luật
 *   `superadmin-resolver.ts`).
 * - message lỗi của parser stdout KHÔNG bao giờ ghép raw output: chính stdout
 *   ghi nhận của bước 9 là secret (plaintext key show-once).
 */

import { ownershipLabels } from '@ecoma-io/deployment';

import { NODE_IMAGE } from './superadmin-resolver.js';

/** Cổng mock serve trong network — đồng bộ `MOCK_UPSTREAM_PORT` mặc định 8787. */
export const MOCK_UPSTREAM_PORT = '8787';

/** Bind address container mode — mock phải nghe mọi interface để DNS nội bộ với tới. */
export const MOCK_BIND_HOST = '0.0.0.0';

/**
 * Đoạn tên mock trong `ecoma-<ns>-<kind>`. Kind này CHƯA nằm trong union đóng
 * `DeployResourceKind` của `libs/deployment` — thêm kind là thay đổi lib dùng
 * chung, nên tên được ghép tại đây với CÙNG hình dạng và validate namespace
 * giống `dockerResourceName`. Follow-up đã nộp: thêm kind vào lib +
 * `CLEANUP_KINDS` của `tools/dx` để `local-cleanup` tự dọn được.
 */
export const MOCK_KIND_SEGMENT = 'llm-upstream-mock';

/** Budget chờ mock phục vụ `GET /v1/models` (tsx cold start + npx resolve). */
export const MOCK_WAIT_BUDGET_MS = 60_000;

/**
 * Tên container mock cho một namespace — hình dạng `ecoma-<ns>-<kind>` giống
 * `dockerResourceName`, ghép tại đây vì kind chưa vào union của lib (xem
 * {@link MOCK_KIND_SEGMENT}). Namespace sai hình là throw — cùng luật lib.
 */
export function mockContainerName(namespace: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(namespace)) {
    throw new Error(`invalid namespace for Docker name: ${namespace}`);
  }
  return `ecoma-${namespace}-${MOCK_KIND_SEGMENT}`;
}

/** URL upstream mà worker serving sẽ dùng — DNS nội bộ của platform network. */
export function mockUpstreamBaseUrl(namespace: string): string {
  return `http://${mockContainerName(namespace)}:${MOCK_UPSTREAM_PORT}`;
}

/**
 * Lệnh healthcheck Docker của container mock — chạy TRONG container, probe
 * `GET /v1/models` kèm header Authorization đọc từ env của chính container
 * (biến `MOCK_UPSTREAM_EXPECTED_AUTHORIZATION`) nên healthcheck chấm đúng bề
 * mặt serving kể cả khi gate auth bật. Trả `exit 0` khi status < 500: một sự
 * cố upstream scenario không được giết container oan; probe MANG header đúng
 * nên 200 là bằng chứng serving thật.
 */
export function buildMockHealthcheckCommand(): string {
  return (
    `node -e "fetch('http://127.0.0.1:${MOCK_UPSTREAM_PORT}/v1/models',` +
    `{headers:{authorization:process.env.MOCK_UPSTREAM_EXPECTED_AUTHORIZATION??''}})` +
    `.then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"`
  );
}

/** Kết quả dựng lời gọi Docker: argv + env để caller thực thi bằng `exec`. */
export interface DockerInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Dựng `docker run -d` của container mock.
 *
 * `expectedAuthorization` là GIÁ TRỊ header Authorization đầy đủ mà mock chấp
 * nhận (`Bearer <credential>` — worker gửi nguyên header này; gate mock so
 * sánh nguyên giá trị). Kênh credential (cùng luật `superadmin-resolver.ts`):
 * giá trị đó đi vào env của PROCESS docker (`-e TÊN` name-only — Docker copy
 * giá trị từ environ của CLI vào container); argv không bao giờ chứa giá trị.
 * Hai env không secret (port, bind host) ghép thẳng `k=v` trong argv cho người
 * đọc thấy cấu hình ngay trên lệnh. Labels ownership để `pnpm dx local-cleanup`
 * truy được nguồn dù kind chưa vào union của lib.
 */
export function buildMockContainerInvocation(inputs: {
  namespace: string;
  networkName: string;
  worktreeRoot: string;
  expectedAuthorization: string;
}): DockerInvocation {
  const labels = ownershipLabels(inputs.worktreeRoot, inputs.namespace);
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => [
    '--label',
    `${key}=${value}`,
  ]);
  const args = [
    'run',
    '-d',
    '--name',
    mockContainerName(inputs.namespace),
    '--network',
    inputs.networkName,
    '-v',
    `${inputs.worktreeRoot}:/repo:ro`,
    '-v',
    `${inputs.worktreeRoot}/node_modules:/repo/node_modules`,
    '-w',
    '/repo',
    '-e',
    `MOCK_UPSTREAM_PORT=${MOCK_UPSTREAM_PORT}`,
    '-e',
    `MOCK_UPSTREAM_HOST=${MOCK_BIND_HOST}`,
    '-e',
    'MOCK_UPSTREAM_EXPECTED_AUTHORIZATION',
    ...labelArgs,
    '--health-cmd',
    buildMockHealthcheckCommand(),
    '--health-interval=10s',
    '--health-timeout=5s',
    '--health-retries=30',
    '--health-start-period=60s',
    NODE_IMAGE,
    'npx',
    'tsx',
    'tools/llm-upstream-mock/src/main.ts',
  ];
  return {
    args,
    env: { MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: inputs.expectedAuthorization },
  };
}

/**
 * Dựng container waiter ephemeral — probe readiness mock TỪ TRONG network:
 * mock không publish cổng ra host (platform invariant), nên probe từ host là
 * không thể. Script retry tới `budgetMs` rồi exit 1 (fail-closed — không có
 * readiness thì `local.ts up` không được chạy vì probe 8b sẽ render offer
 * `draft`). Credential đi env pass-through như container mock; script im
 * lặng — verdict là exit code.
 */
export function buildMockWaiterInvocation(inputs: {
  networkName: string;
  mockUrl: string;
  budgetMs: number;
  expectedAuthorization: string;
}): DockerInvocation {
  const script =
    `(async()=>{const deadline=Date.now()+${inputs.budgetMs};` +
    `while(Date.now()<deadline){` +
    `try{const r=await fetch('${inputs.mockUrl}/v1/models',` +
    `{headers:{authorization:process.env.MOCK_AUTH??''}});if(r.ok)process.exit(0);}catch{}` +
    `await new Promise(res=>setTimeout(res,1000));}` +
    `process.exit(1);})()`;
  return {
    args: [
      'run',
      '--rm',
      '--network',
      inputs.networkName,
      '-e',
      'MOCK_AUTH',
      NODE_IMAGE,
      'node',
      '-e',
      script,
    ],
    env: { MOCK_AUTH: inputs.expectedAuthorization },
  };
}

/** Tiền tố dòng máy đọc plaintext key trên stdout ghi nhận của bước 9. */
export const CONSUMER_HANDOFF_LINE_PREFIX = 'ECOMA_CONSUMER_API_KEY=';

/**
 * Stdout ghi nhận có mang dòng plaintext key không — dùng cho skip-converged
 * của entry: true nghĩa stack đã hội tụ và `local.ts up` phải SKIP (chạy thêm
 * sẽ xoay password role và thay stdout ghi nhận, mất plaintext).
 */
export function hasConsumerApiKeyLine(recordedStdout: string): boolean {
  return recordedStdout.split('\n').some((line) => line.startsWith(CONSUMER_HANDOFF_LINE_PREFIX));
}

/**
 * Trích plaintext key từ stdout ghi nhận của bước 9 (đọc qua
 * `pulumi stack output consumerApiKeyStdout --show-secrets`). Throw khi hợp
 * đồng stdout gãy — message KHÔNG bao giờ chứa raw output vì chính nó là
 * secret (luật không-leak của `readStackConfig`).
 */
export function extractConsumerApiKeyRecordedStdout(recordedStdout: string): string {
  for (const line of recordedStdout.split('\n')) {
    if (line.startsWith(CONSUMER_HANDOFF_LINE_PREFIX)) {
      const value = line.slice(CONSUMER_HANDOFF_LINE_PREFIX.length).trim();
      if (value !== '') return value;
      throw new Error(
        'recorded step-9 stdout carries an empty ECOMA_CONSUMER_API_KEY value; the stdout contract is broken',
      );
    }
  }
  throw new Error(
    'recorded step-9 stdout carries no ECOMA_CONSUMER_API_KEY line; the show-once plaintext was never recorded by this stack state',
  );
}

/** Trạng thái lane mà suite E2E cần — gói trong MỘT dòng `LANE_STATE=`. */
export interface LaneState {
  readonly namespace: string;
  readonly networkName: string;
  readonly tenantOwnerSub: string;
  readonly consumerApiKey: string;
}

/**
 * Dựng dòng envelope `LANE_STATE=<json>` — stdout máy đọc của lệnh `state`,
 * cùng hình contract stdout/stderr của các runner bootstrap (stdout CHỈ mang
 * dòng máy đọc; log người đọc đi stderr). JSON.stringify giữ một dòng.
 */
export function buildLaneStateLine(state: LaneState): string {
  return `LANE_STATE=${JSON.stringify({
    namespace: state.namespace,
    networkName: state.networkName,
    tenantOwnerSub: state.tenantOwnerSub,
    consumerApiKey: state.consumerApiKey,
  })}`;
}
