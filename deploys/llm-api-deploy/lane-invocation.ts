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

import { dockerResourceName, type DeployResourceKind, ownershipLabels } from '@ecoma-io/deployment';

import { NODE_IMAGE } from './superadmin-resolver.js';

/** Cổng mock serve trong network — đồng bộ `MOCK_UPSTREAM_PORT` mặc định 8787. */
export const MOCK_UPSTREAM_PORT = '8787';

/** Bind address container mode — mock phải nghe mọi interface để DNS nội bộ với tới. */
export const MOCK_BIND_HOST = '0.0.0.0';

/**
 * Đoạn tên mock trong `ecoma-<ns>-<kind>` — kind chính thức trong union đóng
 * `DeployResourceKind` của `libs/deployment` (#187). Tên đi qua
 * `dockerResourceName` (validate namespace cùng luật lib) và `local-cleanup`
 * của `tools/dx` nhận diện được container mồ côi qua `CLEANUP_KINDS`.
 */
export const MOCK_KIND_SEGMENT: DeployResourceKind = 'llm-upstream-mock';

/** Budget chờ mock phục vụ `GET /v1/models` (tsx cold start + npx resolve). */
export const MOCK_WAIT_BUDGET_MS = 60_000;

/**
 * Tên container mock cho một namespace — `dockerResourceName` của lib với kind
 * {@link MOCK_KIND_SEGMENT}; namespace sai hình là throw (cùng luật lib).
 */
export function mockContainerName(namespace: string): string {
  return dockerResourceName(namespace, MOCK_KIND_SEGMENT);
}

/** URL upstream mà worker serving sẽ dùng — DNS nội bộ của platform network. */
export function mockUpstreamBaseUrl(namespace: string): string {
  return `http://${mockContainerName(namespace)}:${MOCK_UPSTREAM_PORT}`;
}

/**
 * Đường chat completions trên upstream OpenAI-compatible — đồng bộ
 * `UPSTREAM_PATH` của integration suite `apps/llm-api` (`/v1/chat/completions`):
 * worker POST thẳng endpoint URL đã đăng ký (`upstream_endpoints.url`) KHÔNG
 * ghép thêm path nào, nên giá trị config `namespace:llmUpstreamBaseUrl` của
 * lane PHẢI mang sẵn đường này, không phải root mock.
 */
export const MOCK_CHAT_COMPLETIONS_PATH = '/v1/chat/completions';

/**
 * Giá trị config `namespace:llmUpstreamBaseUrl` của lane — endpoint URL ĐẦY ĐỦ
 * mà serving POST tới. Bootstrap marketplace dùng CÙNG giá trị này làm base
 * cho probe 8b (suy `GET {base}/v1/models`); mock route-match theo hậu tố nên
 * cả hai hợp đồng cùng chạm đúng route (xem README mock, mục Responsibilities).
 */
export function mockUpstreamEndpointUrl(namespace: string): string {
  return `${mockUpstreamBaseUrl(namespace)}${MOCK_CHAT_COMPLETIONS_PATH}`;
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
 * truy được nguồn (kind `llm-upstream-mock` đã vào union của lib, #187).
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

/**
 * Tiền tố dòng máy đọc plaintext key trên stdout ghi nhận của bước 9 — đúng
 * dòng `ECOMA_CONSUMER_API_KEY=` mà runner bước 9 in.
 *
 * Tên `CONSUMER_HANDOFF_LINE_PREFIX` (không `ApiKey`/`Key` trần): rule
 * `generic-api-key` của gitleaks khớp dạng `<từ khoá>… = '<giá trị ≥ 10 ký tự
 * word>'` trên cùng một dòng, còn hằng này KHÔNG phải secret — giá trị là
 * marker hợp đồng stdout mà runner in, không bao giờ là plaintext. Đổi tên
 * thoát heuristic thay vì thêm mục allowlist (cùng cách commit a709f55 đối
 * với heuristic taint của semgrep); giá trị giữ nguyên từng byte vì là hợp
 * đồng với stdout ghi nhận của bước 9.
 */
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

/**
 * Đối chứng skip-converged của entry: stack output `consumerApiKeyStdout` còn
 * giữ plaintext KHÔNG chứng minh database còn row key tương ứng — database có
 * thể bị reset ngoài vòng đời lane (row mất) trong khi state Pulumi giữ nguyên
 * output cũ. Bộ ba dưới đây là phần THUẦN của guard đó (builder argv probe +
 * parser ô count + hàm quyết định skip), để spec colocated chấm được hợp đồng
 * mà không exec Docker/psql nào; phần impure (chạy `docker exec`) nằm ở entry
 * `lane.ts` — đúng hình cùng cặp builder/parser phía trên.
 */

/**
 * Database vật lý chứa schema `llm_gateway` — cùng hằng `GATEWAY_DATABASE` của
 * suite (`system-tests/e2e/llm-inference-e2e/support/lane.mts`, nguồn cùng
 * lane). Giá trị là provision của chính deploy unit này, không phải secret.
 */
export const GATEWAY_DATABASE = 'db-llm-gateway';

/**
 * Id tenant consumer canonical — hằng từng-byte cùng `CONSUMER_TENANT_ID` của
 * `apps/llm-api/db/bootstrap-shared.mts` (runner bước 9 ghi row `api_keys` với
 * đúng id này; không truyền giá trị xuyên DB, hai bên cùng đọc hằng trong code).
 */
export const CONSUMER_TENANT_ID = 'consumer-tenant-ecoma';

/**
 * SQL probe của guard skip-converged — MỘT `SELECT count(*)` chỉ đọc đếm row
 * `api_keys` ACTIVE (`revoked_at IS NULL`) của đúng tenant consumer canonical.
 * Hằng nội suy từ hằng id nên SQL không bao giờ mang input chưa kiểm; không có
 * câu lệnh ghi nào trong chuỗi này.
 */
export const CONSUMER_API_KEY_ROW_PROBE_SQL = `SELECT count(*) FROM llm_gateway.api_keys WHERE tenant_id = '${CONSUMER_TENANT_ID}' AND revoked_at IS NULL`;

/**
 * Dựng argv `docker exec` của probe row api_keys — chạy psql TRONG container
 * PostgreSQL platform của namespace, cùng cơ chế chỉ đọc mà suite dùng
 * (`psqlQuery` của `lane.mts`: `-tAc` trả ô thô). argv chỉ chứa tên container,
 * flag và SQL hằng — KHÔNG có giá trị secret nào đi qua argv (row count là
 * metadata, không phải credential). Namespace sai hình là throw — cùng luật
 * `dockerResourceName` của lib.
 */
export function consumerApiKeyRowProbeArgs(namespace: string): string[] {
  return [
    'exec',
    dockerResourceName(namespace, 'postgres'),
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    GATEWAY_DATABASE,
    '-tAc',
    CONSUMER_API_KEY_ROW_PROBE_SQL,
  ];
}

/**
 * SQL xoá row `api_keys` của đúng tenant consumer canonical — recovery được
 * tài liệu trên chính thông điệp guard show-once của entry (`lane.ts`): sau
 * một lần `local.ts up` ép chạy lại, runner bước 9 hội tụ `existing` trên row
 * cũ và stdout ghi nhận mất plaintext; xoá row rồi cho `local.ts up` chạy lại
 * là đường phát key mới có ghi nhận plaintext. Chỉ `DELETE` đúng tenant id
 * hằng; không có input tự do nào ghép vào chuỗi này.
 */
export const CONSUMER_API_KEY_ROW_DELETE_SQL = `DELETE FROM llm_gateway.api_keys WHERE tenant_id = '${CONSUMER_TENANT_ID}'`;

/**
 * Dựng argv `docker exec` xoá row api_keys của tenant consumer — cùng cơ chế
 * với {@link consumerApiKeyRowProbeArgs}; namespace sai hình là throw.
 */
export function consumerApiKeyRowDeleteArgs(namespace: string): string[] {
  return [
    'exec',
    dockerResourceName(namespace, 'postgres'),
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    GATEWAY_DATABASE,
    '-tAc',
    CONSUMER_API_KEY_ROW_DELETE_SQL,
  ];
}

/**
 * Parse ô count của probe (`-tAc` in một ô, kết thúc `\n`). Số âm hoặc không
 * phải số nguyên là hợp đồng SQL gãy — fail-closed kèm message KHÔNG ghép raw
 * output (cùng luật không-leak của parser stdout ghi nhận phía trên).
 */
export function activeConsumerApiKeyRowCount(probeStdout: string): number {
  const value = Number.parseInt(probeStdout.trim(), 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      'the api key row probe returned a non-integer count; the SQL contract is broken',
    );
  }
  return value;
}

/** Database vật lý chứa schema `llm_marketplace` — đối chiếu migration drizzle. */
export const MARKETPLACE_DATABASE = 'db-llm-marketplace';

/**
 * Model E2E canonical của lane — cùng model id suite inference dùng
 * (`DRONIE_MODEL_ID` của cross-product journey). Lane hội tụ E2E khi offer của
 * model này `active`: activation là verdict của domain (`activateModelOffer`
 * đòi pool + endpoint healthy), nên offer active là bằng chứng đủ rằng chuỗi
 * bootstrap 8b đã probe upstream thành công.
 */
export const CANONICAL_E2E_MODEL_ID = 'dronie-flash';

/**
 * Probe offer E2E canonical đã `active` chưa — cửa sổ hội tụ serving của lane
 * (issue #436). Đếm 0 nghĩa là bootstrap chưa từng probe upstream thành công
 * (đúng ca fresh volume với default `.invalid`): lane KHÔNG được skip khi đó,
 * phải chạy `local.ts up` để bootstrap re-run với URL mock đã ghi đè.
 */
export const OFFER_SERVING_PROBE_SQL = `SELECT count(*) FROM llm_marketplace.model_offers WHERE normalized_model_id = '${CANONICAL_E2E_MODEL_ID}' AND status = 'active'`;

/**
 * Dựng argv `docker exec` của probe offer serving — cùng cơ chế chỉ đọc với
 * {@link consumerApiKeyRowProbeArgs}: psql trong container postgres của
 * namespace, `-tAc` trả ô thô, không secret qua argv, namespace sai hình là
 * throw.
 */
export function offerServingProbeArgs(namespace: string): string[] {
  return [
    'exec',
    dockerResourceName(namespace, 'postgres'),
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    MARKETPLACE_DATABASE,
    '-tAc',
    OFFER_SERVING_PROBE_SQL,
  ];
}

/** Parse ô count của probe offer — cùng hợp đồng parse với api key probe. */
export function activeOfferServingCount(probeStdout: string): number {
  const value = Number.parseInt(probeStdout.trim(), 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      'the offer serving probe returned a non-integer count; the SQL contract is broken',
    );
  }
  return value;
}

/**
 * Dựng argv xoá các row endpoint ĐÃ LỆCH khỏi URL upstream vừa được cấu hình
 * — recovery được tài liệu của chính bootstrap (endpoint target là bất biến
 * qua bootstrap; đổi target phải xoá row rồi cho bootstrap chạy lại). Chỉ xoá
 * endpoint của offer canonical có url KHÁC URL mới; offer/pool giữ nguyên vì
 * 8b rerun tự tái tạo endpoint theo natural key. `configuredUrl` bắt buộc khớp
 * hình endpoint mock của lane (host DNS + port + đường chat) — lệch hình là
 * throw trước khi SQL nào được ghép, nên argv không mang giá trị tự do.
 */
export function divergedUpstreamEndpointDeleteArgs(
  namespace: string,
  configuredUrl: string,
): string[] {
  if (!/^http:\/\/[a-z0-9.-]+:\d+\/v1\/chat\/completions$/u.test(configuredUrl)) {
    throw new Error(
      `the configured upstream URL does not match the lane mock endpoint shape; refusing to build the diverged-endpoint cleanup argv for "${configuredUrl}"`,
    );
  }
  const sql =
    `DELETE FROM llm_marketplace.upstream_endpoints e ` +
    `USING llm_marketplace.endpoint_pools p, llm_marketplace.model_offers o ` +
    `WHERE e.pool_id = p.id AND p.offer_id = o.id ` +
    `AND o.normalized_model_id = '${CANONICAL_E2E_MODEL_ID}' ` +
    `AND e.url <> '${configuredUrl}'`;
  return [
    'exec',
    dockerResourceName(namespace, 'postgres'),
    'psql',
    '-U',
    'ecoma_local',
    '-d',
    MARKETPLACE_DATABASE,
    '-tAc',
    sql,
  ];
}

/**
 * Quyết định skip-converged của `up`: skip CHỈ khi đồng thời (1) stdout ghi
 * nhận trong stack output còn mang dòng plaintext key (show-once của bước 9 —
 * chạy `local.ts up` thêm sẽ xoay password role và thay stdout, mất plaintext),
 * (2) probe database thấy ÍT NHẤT MỘT row `api_keys` active của tenant
 * consumer, và (3) offer E2E canonical đã `active` (serving E2E hội tụ —
 * issue #436: fresh volume bootstrap lần đầu chạy với default `.invalid` để
 * offer kẹt `draft`; skip ở ca đó là che mất việc bootstrap chưa từng chạm
 * upstream thành công). Output còn mà row/offer mất (database bị reset ngoài
 * vòng đời) là NGHỊCH
 * — không skip, chạy `local.ts up` đầy đủ để bootstrap phát key mới qua hợp
 * đồng converge-on-empty của runner bước 9.
 */
export function shouldSkipLaneUp(
  recordedStdout: string | undefined,
  activeRowCount: number,
  activeOfferRowCount: number,
): boolean {
  return (
    recordedStdout !== undefined &&
    hasConsumerApiKeyLine(recordedStdout) &&
    activeRowCount > 0 &&
    activeOfferRowCount > 0
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
