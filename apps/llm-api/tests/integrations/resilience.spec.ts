import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  databaseName,
  roleConnectionString,
  runtimeRole,
  startLlmApiDatabase,
  type LlmApiDatabase,
  type LlmDatabaseKey,
} from './harness';

/**
 * Hành vi vận hành của runtime Worker `llm-api` đo trên workerd thật — bổ sung
 * cho hợp đồng HTTP đóng băng của `http-contract.spec.ts` (file đó ghim
 * status/body/content-type của từng endpoint; file này ghim hành vi theo
 * **thời gian** và theo **vòng đời phụ thuộc**):
 *
 * 1. Độ phân giải (resolution): các request `/ready` đồng thời phải cùng
 *    200 — readiness per-binding 3 probe song song không đầu độc lẫn nhau.
 * 2. Deadline readiness: binding không trả lời (IP non-routable, không
 *    connection-refused) phải bị deadline 3s per-binding chốt là `timeout`
 *    → 503, và NHÃN trong log phải là `timeout` chứ không phải `unavailable`
 *    — hai trạng thái khác nhau của hợp đồng readiness (đúng semantics Rust
 *    `src/readiness.rs`). Hai binding còn lại vẫn `ready` — fail-closed từng
 *    binding, không lan.
 * 3. Phục hồi: database chết (docker stop) → 503 fail-closed; database sống
 *    lại (docker start) → `/ready` (và data plane) trở về 200 không cần
 *    can thiệp. Runtime KHÔNG giữ kết nối idle giữa các phép gọi (một
 *    `pg.Client` mỗi phép gọi — xem `src/connections.ts`), nên không có
 *    pool hỏng phải reset: đường phục hồi là tái kết nối tự nhiên của phép
 *    gọi kế tiếp.
 * 4. Không rò rỉ (invariant platform): connection string và credential
 *    KHÔNG BAO GIỜ xuất hiện trong body response hay log của worker — cả
 *    đường thành công lẫn đường 503.
 *
 * Hyperdrive local emulation đọc biến môi trường
 * `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` lúc **dựng**
 * binding, nên mỗi describe dựng harness riêng sau khi set env tương ứng
 * (tiền lệ `http-contract.spec.ts`); describe chạy tuần tự trong file nên
 * mutate env giữa chừng là an toàn. Docker là phụ thuộc cứng — thiếu Docker
 * là ĐỎ, không skip (06-testing.md §6).
 */

const execFileAsync = promisify(execFile);

const APP_DIR = resolve(import.meta.dirname, '..', '..');

/** `require('wrangler')` thay vì `await import`: CLI bundle lớn, giữ ngoài pipeline transform của vitest (tiền lệ backoffice). */
const wranglerCli = createRequire(import.meta.url)('wrangler') as typeof import('wrangler');

type TestHarness = Awaited<ReturnType<typeof wranglerCli.createTestHarness>>;

const WORKER_CONFIG_PATH = resolve(APP_DIR, 'wrangler.jsonc');

/** Ánh xạ khóa database → tên Hyperdrive binding, khớp chính xác `wrangler.jsonc`. */
const BINDING_BY_KEY: Record<LlmDatabaseKey, string> = {
  gateway: 'DB_LLM_GATEWAY',
  tenant: 'DB_LLM_TENANT',
  marketplace: 'DB_LLM_MARKETPLACE',
};

/** Tên biến môi trường connection string local của một binding Hyperdrive. */
function hyperdriveEnvName(binding: string): string {
  return `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`;
}

/** Giá trị env trước khi suite chạy — `afterAll` khôi phục đúng trạng thái ban đầu kể cả khi setup hỏng giữa chừng. */
const previousConnectionStrings = new Map<string, string | undefined>();

/** Chụp giá trị env hiện tại vào bản khôi phục (chạy một lần, trước harness đầu tiên). */
function captureConnectionStrings(): void {
  for (const binding of Object.values(BINDING_BY_KEY)) {
    if (!previousConnectionStrings.has(binding)) {
      previousConnectionStrings.set(binding, process.env[hyperdriveEnvName(binding)]);
    }
  }
}

/** Set connection string local cho cả ba binding bằng database thật của harness. */
function setRealConnectionStrings(db: LlmApiDatabase): void {
  for (const key of ['gateway', 'tenant', 'marketplace'] as const) {
    process.env[hyperdriveEnvName(BINDING_BY_KEY[key])] = roleConnectionString(
      runtimeRole(key),
      databaseName(key),
      db.host,
      db.port,
    );
  }
}

/**
 * Khởi động harness workerd cho config `wrangler.jsonc` của app. Env phải set
 * TRƯỚC khi gọi — binding đọc connection string lúc dựng (tiền lệ backoffice).
 */
async function bootHarness(): Promise<TestHarness> {
  const harness = wranglerCli.createTestHarness({
    root: APP_DIR,
    workers: [{ configPath: WORKER_CONFIG_PATH }],
  });
  await harness.listen();
  return harness;
}

interface RouteResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/** GET một path qua worker runtime của harness cho trước (URL tuyệt đối — `harness.fetch` không resolve path tương đối). */
async function fetchRouteOn(target: TestHarness, path: string): Promise<RouteResponse> {
  const response = await target.fetch(`http://worker.invalid${path}`, { method: 'GET' });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  };
}

/** Tất cả message log của worker, đúng thứ tự phát ra. */
function workerLogs(target: TestHarness): string[] {
  return target.getLogs().map((entry) => entry.message);
}

/**
 * Khẳng định không có connection string lẫn credential trong toàn bộ chuỗi
 * cho trước. Invariant platform: `postgresql://` (scheme của chuỗi kết nối)
 * và mật khẩu role test phải vắng mặt — một lần xuất hiện là rò rỉ thật,
 * bất kể ngữ cảnh.
 */
function expectNoConnectionString(leakCandidates: string[]): void {
  for (const candidate of leakCandidates) {
    expect(candidate).not.toContain('postgresql://');
    expect(candidate).not.toContain('ecoma_test_role_pw');
  }
}

/** ID container Docker đang publish đúng cổng host của database test. */
async function findContainerIdByPort(port: number): Promise<string> {
  const { stdout } = await execFileAsync('docker', [
    'ps',
    '--filter',
    `publish=${port}`,
    '--format',
    '{{.ID}}',
  ]);
  const ids = stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

describe('llm-api worker operational behaviour', () => {
  let db: LlmApiDatabase;
  let harness: TestHarness;

  beforeAll(async () => {
    captureConnectionStrings();
    db = await startLlmApiDatabase();
    setRealConnectionStrings(db);
    harness = await bootHarness();
  }, 240_000);

  afterAll(async () => {
    await harness?.close();
    await db?.stop();
  });

  // WK5 (platform facts): trần 6 kết nối đồng thời khi chờ header — ba request
  // `/ready` đồng thời tạo 9 kết nối đang bay (3 probe/request); workerd xếp
  // hàng phần thừa, vẫn dư dả so với deadline 3s. Số 3 là nhỏ nhất chứng minh
  // được tính chất "các request độc lập" mà không nhân cảm ứng platform lên.
  it('serves concurrent /ready requests while every binding stays healthy', async () => {
    const responses = await Promise.all([
      fetchRouteOn(harness, '/ready'),
      fetchRouteOn(harness, '/ready'),
      fetchRouteOn(harness, '/ready'),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.contentType).toBe('text/plain; charset=utf-8');
      expect(response.body).toBe('ready');
    }
  }, 30_000);

  it('keeps connection strings and credentials out of every response and worker log', async () => {
    const bodies: string[] = [];
    for (const path of ['/health', '/ready', '/v1/models']) {
      const response = await fetchRouteOn(harness, path);
      expect(response.status).toBe(200);
      bodies.push(response.body);
    }

    expectNoConnectionString([...bodies, ...workerLogs(harness)]);
  }, 30_000);
});

describe('readiness deadline on a binding that never answers', () => {
  let db: LlmApiDatabase;
  let harness: TestHarness;

  beforeAll(async () => {
    captureConnectionStrings();
    db = await startLlmApiDatabase();
    setRealConnectionStrings(db);
    // Gateway trỏ sang IP non-routable (RFC 1918 chưa cấp, không host nào
    // trả lời): TCP SYN không bao giờ được ACK — KHÔNG connection-refused.
    // Kịch bản này buộc deadline 3s của binding phải là cơ chế chốt trạng
    // thái, đúng điều hợp đồng readiness phân biệt với `unavailable`.
    process.env[hyperdriveEnvName(BINDING_BY_KEY.gateway)] =
      'postgresql://ecoma_llm_gateway_runtime:ecoma_test_role_pw@10.255.255.1:5432/db-llm-gateway';
    harness = await bootHarness();
  }, 240_000);

  afterAll(async () => {
    await harness?.close();
    await db?.stop();
    // Khôi phục connection string THẬT của gateway (không xoá): describe kế
    // tiếp trong file vẫn cần database thật.
    setRealConnectionStrings(db);
  });

  it('fails closed through the per-binding deadline when a binding does not answer', async () => {
    const started = Date.now();
    const response = await fetchRouteOn(harness, '/ready');
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    expect(response.contentType).toBe('');
    expect(response.body).toBe('not ready');
    // Deadline per-binding là 3s: đủ sớm hơn `connectionTimeoutMillis` 5s để
    // deadline thắng cuộc đua, đủ muộn hơn mọi round-trip thật trong môi
    // trường test (đo đạc: query lành mạnh ~10ms qua Hyperdrive local).
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(elapsed).toBeLessThan(10_000);

    // Nhãn per-binding trong log là bằng chứng trạng thái: gateway bị deadline
    // chốt `timeout`. `failures()` liệt kê CHỈ các binding chưa ready (ready
    // bị bỏ khỏi dòng log), nên hai binding lành mạnh phải VẮNG MẶT khỏi
    // dòng — có mặt nghĩa là probe của chúng cũng hỏng (fail-closed lan, sai
    // semantics per-binding của Rust).
    const failureLine = workerLogs(harness).find((message) =>
      message.includes('/ready not ready:'),
    );
    expect(failureLine).toBeDefined();
    expect(failureLine).toContain('DB_LLM_GATEWAY=timeout');
    expect(failureLine).not.toContain('DB_LLM_TENANT=');
    expect(failureLine).not.toContain('DB_LLM_MARKETPLACE=');
  }, 30_000);

  it('keeps credentials out of the failure path responses and logs', async () => {
    const response = await fetchRouteOn(harness, '/ready');
    expect(response.status).toBe(503);
    expect(response.body).toBe('not ready');

    expectNoConnectionString([response.body, ...workerLogs(harness)]);
  }, 30_000);
});

describe('recovery after the database comes back', () => {
  let db: LlmApiDatabase;
  let harness: TestHarness;

  beforeAll(async () => {
    captureConnectionStrings();
    // Cổng host PHẢI ghim tường minh: dưới rootless Docker, RootlessKit KHÔNG
    // re-bind cổng host do Docker cấp ngẫu nhiên khi container start lại — cổng
    // cũ refused vĩnh viễn, cổng publish đổi sang giá trị khác (đo ở trên).
    // Cổng ghim được re-roll khi dựng container va chạm với listener khác —
    // va chạm ba lần liên tiếp là xác suất không đáng kể.
    let dbUp: LlmApiDatabase | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && dbUp === undefined; attempt++) {
      const pinnedPort = 25_000 + Math.floor(Math.random() * 20_000);
      try {
        dbUp = await startLlmApiDatabase({ pinnedPort });
      } catch (error) {
        lastError = error;
      }
    }
    if (dbUp === undefined) {
      throw lastError;
    }
    db = dbUp;
    setRealConnectionStrings(db);
    harness = await bootHarness();
  }, 240_000);

  afterAll(async () => {
    await harness?.close();
    // `db.stop()` ở trạng thái container đã start lại vẫn hợp lệ: testcontainers
    // stop đúng container nó đã start, bất kể vòng stop/start giữa chừng.
    await db?.stop();
  });

  // Chạy CUỐI describe này (và cuối file): nó stop container database chung
  // của chính describe — không test nào sau nó được phụ thuộc database sống.
  it('recovers to ready after the database restarts without worker intervention', async () => {
    const containerId = await findContainerIdByPort(db.port);
    expect(containerId).not.toBe('');

    // Database chết: đường gọi kế tiếp tự mở kết nối mới và nhận lỗi ngay —
    // 503 fail-closed, không treo, không 200 giả.
    await execFileAsync('docker', ['stop', containerId]);
    const down = await fetchRouteOn(harness, '/ready');
    expect(down.status).toBe(503);
    expect(down.body).toBe('not ready');

    // Database sống lại: KHÔNG khởi động lại worker, KHÔNG reset gì — request
    // kế tiếp phải tự hồi phục. PostgreSQL cần vài giây khởi động lại, nên
    // poll cho đến khi `/ready` trả 200, với trần 60s. `docker start` có thể
    // va chạm RootlessKit-port hiếm gặp, nên mỗi lần thử start có backoff nhỏ;
    // bốn lần thử liên tiếp thất bại là lỗi thật — để đỏ. Mỗi lần poll được
    // lưu lại để assertion cuối báo đúng trình tự thời gian thay vì "không
    // thấy 200" vô căn cứ.
    let started = false;
    for (let attempt = 0; attempt < 4 && !started; attempt++) {
      try {
        await execFileAsync('docker', ['start', containerId]);
        started = true;
      } catch {
        await new Promise<void>((resolveSleep) => {
          setTimeout(resolveSleep, 5_000);
        });
      }
    }
    expect(started, 'docker start failed four consecutive times').toBe(true);

    const polls: string[] = [];
    const recoveryDeadline = Date.now() + 60_000;
    let recovered: RouteResponse | undefined;
    while (Date.now() < recoveryDeadline) {
      const attempt = await fetchRouteOn(harness, '/ready');
      polls.push(`status=${attempt.status} body="${attempt.body}"`);
      if (attempt.status === 200) {
        recovered = attempt;
        break;
      }
      await new Promise<void>((resolveSleep) => {
        setTimeout(resolveSleep, 2_000);
      });
    }
    expect(
      recovered,
      `no successful /ready within 60s; polls: ${polls.join(' | ')}; logs: ${workerLogs(harness).slice(-5).join(' || ')}`,
    ).toBeDefined();
    expect(recovered?.body).toBe('ready');

    // Data plane cùng hồi phục theo readiness: catalogue (đọc hai binding)
    // trở về 200 với danh sách rỗng đúng hợp đồng (chưa seed offer nào).
    const models = await fetchRouteOn(harness, '/v1/models');
    expect(models.status).toBe(200);
    expect(models.body).toBe('{"object":"list","data":[]}');

    expectNoConnectionString([
      down.body,
      recovered?.body ?? '',
      models.body,
      ...workerLogs(harness),
    ]);
  }, 180_000);
});
