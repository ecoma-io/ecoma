import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  databaseName,
  roleConnectionString,
  ROLE_PASSWORD,
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
 * 5. Quá tải admission (review P2): burst `/ready` vượt admission
 *    per-binding phải có hành vi định đoạt — mỗi response là 200 hoặc 503
 *    (không treo, không 500), hoàn tất trong trần thời gian hữu hạn, và
 *    capacity phục hồi ngay sau burst.
 * 6. Terminate thật khi hết deadline (review P1): binding chấp nhận TCP,
 *    hoàn tất bắt tay PostgreSQL rồi IM LẶNG với query — deadline 3s phải
 *    đóng socket phía server (force-destroy của pg chạy xuyên workerd),
 *    không chỉ trả 503 rồi bỏ mạng query chạy nền.
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

/*
 * Hằng số có tên cho mọi con số "magic" của harness — mỗi giá trị một nghĩa,
 * không số mã hóa rải rác trong test.
 */

/** Trần dưới elapsed của test deadline: deadline 3s phải là cơ chế chốt (thắng cuộc đua), không phải kết thúc sớm bất thường. */
const DEADLINE_FLOOR_MS = 2_500;
/** Trần trên elapsed: deadline HỦY operation nên tổng thời gian ôm sát 3s — chỉ dư địa jitter cho probe xếp hàng ở workerd (WK5), không phải trần 10s mông lung. */
const DEADLINE_CEILING_MS = 5_000;
/** Trần trên thời điểm socket phía server bị đóng kể từ khi bắt đầu request: deadline 3s + dư địa poll/jitter CI. */
const STALL_CLOSE_CEILING_MS = 8_000;
/** Số request `/ready` đồng thời trong test burst quá tải. */
const BURST_REQUESTS = 12;
/** Trần thời gian hoàn tất của cả burst — queue bounded + deadline không cho ai treo vô hạn. */
const BURST_WALL_LIMIT_MS = 10_000;
/** Cơ số cổng host ghim của test recovery (tránh đụng listener khác). */
const PINNED_PORT_BASE = 25_000;
/** Biên độ ríu cổng ghim của test recovery. */
const PINNED_PORT_SPAN = 20_000;
/** Số lần thử `docker start` tối đa (RootlessKit-port hiếm gặp) trước khi đỏ. */
const DOCKER_START_ATTEMPTS = 4;
/** Backoff giữa các lần thử `docker start`. */
const DOCKER_START_BACKOFF_MS = 5_000;
/** Trần thời gian poll `/ready` sau khi database sống lại. */
const RECOVERY_WINDOW_MS = 60_000;
/** Khoảng nghỉ giữa các lần poll phục hồi. */
const RECOVERY_POLL_INTERVAL_MS = 2_000;

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

/** Khôi phục MỌI connection string về giá trị captured trước suite — idempotent, gọi ở `afterAll` của từng describe (review: không mutate env chéo describe). */
function restoreConnectionStrings(): void {
  for (const [envName, value] of previousConnectionStrings) {
    // Gán `undefined` thay vì `delete` (no-dynamic-delete): với process.env,
    // giá trị undefined tương đương không-set khi đọc lẫn khi dựng binding.
    process.env[envName] = value;
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
    expect(candidate).not.toContain(ROLE_PASSWORD);
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
  if (ids.length === 0) {
    throw new Error(
      `no docker container publishes port ${port} - the test database container is not running`,
    );
  }
  if (ids.length > 1) {
    throw new Error(
      `expected exactly one docker container publishing port ${port}, found ${ids.length}: ${ids.join(', ')}`,
    );
  }
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
    restoreConnectionStrings();
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

  // Review P2: burst vượt admission per-binding (limit 3 + queue 3 mỗi
  // binding) phải định đoạt được — không request nào treo, không 500, burst
  // hoàn tất hữu hạn, và capacity trả lại đầy đủ ngay sau burst. Số học
  // bound (18 in-flight-or-waiting per isolate) được chứng minh ở unit
  // `src/connections.spec.ts`; test này là bằng chứng trên workerd thật.
  it('admits or rejects deterministically under a burst above the admission bound and recovers immediately', async () => {
    const started = Date.now();
    const responses = await Promise.all(
      Array.from({ length: BURST_REQUESTS }, () => fetchRouteOn(harness, '/ready')),
    );
    const wall = Date.now() - started;

    for (const response of responses) {
      expect([200, 503]).toContain(response.status);
      expect([response.body === 'ready', response.body === 'not ready']).toContain(true);
    }
    // Burst hoàn tất hữu hạn: queue bounded + deadline không cho request nào
    // treo vô hạn — wall time phải có trần.
    expect(wall).toBeLessThan(BURST_WALL_LIMIT_MS);

    // Capacity đã trả đủ: request đơn kế tiếp phải 200 như đường lành mạnh.
    const after = await fetchRouteOn(harness, '/ready');
    expect(after.status).toBe(200);
    expect(after.body).toBe('ready');

    expectNoConnectionString([
      ...responses.map((response) => response.body),
      after.body,
      ...workerLogs(harness),
    ]);
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
      `postgresql://ecoma_llm_gateway_runtime:${ROLE_PASSWORD}@10.255.255.1:5432/db-llm-gateway`;
    harness = await bootHarness();
  }, 240_000);

  afterAll(async () => {
    await harness?.close();
    await db?.stop();
    // Khôi phục env về giá trị captured: describe kế tiếp tự set env riêng
    // trước khi boot — không phụ thuộc mutation chéo describe.
    restoreConnectionStrings();
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
    // Trần trên ôm sát deadline vì deadline HỦY operation thật (terminate) —
    // nếu chỉ bỏ cuộc đua mà để query chạy nền thì phải nới trần 10s.
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_FLOOR_MS);
    expect(elapsed).toBeLessThan(DEADLINE_CEILING_MS);

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

describe('deadline terminates a stalled postgresql operation (review P1)', () => {
  let db: LlmApiDatabase;
  let harness: TestHarness;
  let stallServer: Server;
  let acceptedSockets: Socket[];
  let socketCloseTimes: number[];

  beforeAll(async () => {
    captureConnectionStrings();
    db = await startLlmApiDatabase();
    setRealConnectionStrings(db);
    // "Fake PG" tối thiểu qua node:net: trả lời đúng trình tự bắt tay
    // (AuthenticationOk → BackendKeyData → ReadyForQuery) rồi IM LẶNG — query
    // đầu tiên không bao giờ được trả lời. TCP connect thành công, connect
    // phase hoàn tất, query phase treo vô hạn: đúng kịch bản mà Promise.race
    // đơn thuần không giải quyết được (review P1) — deadline phải terminate
    // connection THẬT, không chỉ bỏ cuộc đua response.
    acceptedSockets = [];
    socketCloseTimes = [];
    stallServer = createServer((socket) => {
      acceptedSockets.push(socket);
      socket.on('close', () => {
        socketCloseTimes.push(Date.now());
      });
      socket.on('error', (error) => {
        console.log('[stall-server] socket error:', error.message);
      });
      socket.on('data', (chunk: Buffer) => {
        // Chỉ log TYPE byte của message đầu tiên — không log payload.
        console.log(
          `[stall-server] data ${chunk.length}B head=0x${chunk.subarray(0, 8).toString('hex')}`,
        );
      });
      socket.write(
        Buffer.concat([
          // AuthenticationOk ('R', length 8, code 0)
          Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]),
          // BackendKeyData ('K', length 12, pid/key giả)
          Buffer.from([0x4b, 0, 0, 0, 12, 0, 0, 0x27, 0x10, 0, 0, 0x27, 0x10]),
          // ReadyForQuery ('Z', length 5, idle 'I')
          Buffer.from([0x5a, 0, 0, 0, 5, 0x49]),
        ]),
      );
      // Không đọc, không trả lời gì thêm — query phase treo vĩnh viễn.
    });
    await new Promise<void>((resolveListen) => {
      stallServer.listen(0, '127.0.0.1', resolveListen);
    });
    const stallPort = (stallServer.address() as AddressInfo).port;
    // Gateway trỏ vào stall server (`sslmode=disable` — pg không gửi
    // SSLRequest, handshake thật bắt đầu ngay); hai binding còn lại trỏ
    // database thật: fail-closed per-binding, không lan.
    process.env[hyperdriveEnvName(BINDING_BY_KEY.gateway)] =
      `postgresql://ecoma_llm_gateway_runtime:${ROLE_PASSWORD}@127.0.0.1:${stallPort}/db-llm-gateway?sslmode=disable`;
    harness = await bootHarness();
  }, 240_000);

  afterAll(async () => {
    await harness?.close();
    for (const socket of acceptedSockets) {
      socket.destroy();
    }
    stallServer?.close();
    await db?.stop();
    restoreConnectionStrings();
  });

  it('closes the server-side socket at the deadline instead of only racing the response', async () => {
    const started = Date.now();
    const response = await fetchRouteOn(harness, '/ready');
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    expect(response.body).toBe('not ready');
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_FLOOR_MS);
    expect(elapsed).toBeLessThan(DEADLINE_CEILING_MS);

    // Bằng chứng terminate thật: worker phải accept ÍT NHẤT MỘT kết nối
    // (đủ để connect + handshake xong — operation đã vào query phase) và
    // MỌI kết nối đã accept phải bị đóng NGAY SAU deadline. Force-destroy
    // của pg chạy xuyên workerd tới socket phía server; chỉ trả 503 rồi bỏ
    // query chạy nền thì socket còn mở mãi.
    expect(acceptedSockets.length).toBeGreaterThanOrEqual(1);
    const closePollDeadline = Date.now() + 5_000;
    while (socketCloseTimes.length < acceptedSockets.length && Date.now() < closePollDeadline) {
      await new Promise<void>((resolveSleep) => {
        setTimeout(resolveSleep, 100);
      });
    }
    expect(socketCloseTimes.length).toBe(acceptedSockets.length);
    for (const closeTime of socketCloseTimes) {
      // Đóng DO deadline: thời điểm đóng phải nằm sau trần deadline (3s)
      // của phép gọi và sát sau nó — không phải đóng trước khi query kịp
      // chạy (connect refused sai kịch bản) hay đóng trễ vô hạn.
      expect(closeTime - started).toBeGreaterThanOrEqual(DEADLINE_FLOOR_MS);
      expect(closeTime - started).toBeLessThan(STALL_CLOSE_CEILING_MS);
    }

    // Nhãn trạng thái: gateway bị deadline chốt `timeout`; hai binding
    // lành mạnh VẮNG MẶT khỏi dòng failure (fail-closed per-binding).
    const failureLine = workerLogs(harness).find((message) =>
      message.includes('/ready not ready:'),
    );
    expect(failureLine).toBeDefined();
    expect(failureLine).toContain('DB_LLM_GATEWAY=timeout');
    expect(failureLine).not.toContain('DB_LLM_TENANT=');
    expect(failureLine).not.toContain('DB_LLM_MARKETPLACE=');

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
      const pinnedPort = PINNED_PORT_BASE + Math.floor(Math.random() * PINNED_PORT_SPAN);
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
    restoreConnectionStrings();
  });

  // Chạy CUỐI describe này (và cuối file): nó stop container database chung
  // của chính describe — không test nào sau nó được phụ thuộc database sống.
  it('recovers to ready after the database restarts without worker intervention', async () => {
    const containerId = await findContainerIdByPort(db.port);

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
    for (let attempt = 0; attempt < DOCKER_START_ATTEMPTS && !started; attempt++) {
      try {
        await execFileAsync('docker', ['start', containerId]);
        started = true;
      } catch {
        await new Promise<void>((resolveSleep) => {
          setTimeout(resolveSleep, DOCKER_START_BACKOFF_MS);
        });
      }
    }
    expect(started, 'docker start failed four consecutive times').toBe(true);

    const polls: string[] = [];
    const recoveryDeadline = Date.now() + RECOVERY_WINDOW_MS;
    let recovered: RouteResponse | undefined;
    while (Date.now() < recoveryDeadline) {
      const attempt = await fetchRouteOn(harness, '/ready');
      polls.push(`status=${attempt.status} body="${attempt.body}"`);
      if (attempt.status === 200) {
        recovered = attempt;
        break;
      }
      await new Promise<void>((resolveSleep) => {
        setTimeout(resolveSleep, RECOVERY_POLL_INTERVAL_MS);
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
