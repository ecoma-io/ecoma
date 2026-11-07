/**
 * Spec của `worker-orchestration.ts` — PR4 bring up / status / bring down.
 *
 * Test KHÔNG spawn wrangler thật: `wranglerBin` trỏ tới một fake bin (`.sh`
 * exit 0 cho migration path vì `resolveWranglerInvocation` chạy bin không
 * phải `.js` trực tiếp; `.js` exit 0 cho spawn path qua `spawnImpl` fake).
 * Process thật chỉ dùng ở test teardown (`node -e` long-lived child) để
 * chứng minh kill thật sự qua `stopWorkerRuntime`.
 */

import type { ChildProcess, spawn as childSpawn } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeWorktreeRoot, worktreeNamespace } from '@ecoma-io/deployment';
import { loadReadinessDeclaration, loadWorkerMarkerDeclaration } from './worker-discovery.js';
import {
  devVarsArgv,
  localWorkerEnvInjections,
  MAIL_WORKER_ENTRIES,
  portCandidates,
  resolveWranglerInvocationArgv,
  startWorkerRuntime,
  statusWorkerRuntime,
  stopWorkerRuntime,
} from './worker-orchestration.js';
import { identityHashOf, metadataPathOf, scanWorkerProcesses } from './worker-process.js';

const cleanup: string[] = [];

function makeWorktreeFixture(name: string): string {
  const dir = join(
    tmpdir(),
    `worker-orchestration-spec-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/**
 * Committed config fixture — đủ điều kiện qua `validateCommittedWranglerConfig`
 * (name, main, compatibility_date; KHÔNG account_id; KHÔNG remote:true).
 */
function writeCommittedConfig(dir: string, name: string): string {
  const config = {
    name,
    main: 'dist/main.js',
    compatibility_date: '2026-10-05',
    d1_databases: [{ binding: 'mail', database_name: name.includes('job') ? 'mail-job' : 'mail' }],
  };
  // Cây app fixture: <worktreeRoot>/apps/<name>/wrangler.jsonc — cùng layout
  // với apps thật để `committedConfigPath` tuyệt đối resolve đúng.
  const appDir = join(dir, 'apps', name);
  mkdirSync(appDir, { recursive: true });
  const path = join(appDir, 'wrangler.jsonc');
  writeFileSync(path, JSON.stringify(config), 'utf8');
  return path;
}

/** Spy console.warn — chặn stderr-warn assertions không đụng output thật. */
function viSpyOnConsoleWarn(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

/**
 * Ghi marker opt-in `local-worker.jsonc` vào app dir — PR6 dùng marker là
 * opt-in gate + readiness declaration duy nhất. `writeCommittedConfig` và
 * `writeLikelyQueueApp` gọi cât có thể để fixture sống như một app thật.
 */ function writeLocalWorkerMarker(
  dir: string,
  dirName: string,
  readiness: 'http-health' | 'log-banner',
): void {
  const appDir = join(dir, 'apps', dirName);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'local-worker.jsonc'), `${JSON.stringify({ readiness })}\n`, 'utf8');
}

/**
 * Queue app fixture — worker có `-job` trong tên là consumer (shape config
 * thật: consume queue như transactional-mailer-job), ngược lại producer.
 * Marker readiness được khai tường minh theo `isConsumer`: queue-only
 * worker không expose HTTP → banner; producer có serving route → HTTP.
 * Dùng cho test boot order theo queue dependency của discovery (PR6).
 */
function writeLikelyQueueApp(
  dir: string,
  dirName: string,
  workerName: string,
  queueName: { queue: string },
): string {
  const isConsumer = workerName.includes('-job');
  const config = {
    name: workerName,
    main: 'dist/main.js',
    compatibility_date: '2026-10-05',
    workers_dev: false,
    // OCR round-2 F8: mỗi app một database_name riêng — hai app của cùng
    // fixture dùng chung 'push-job' là duplicate database_name fail-closed.
    d1_databases: [{ binding: 'push-job', database_name: `${dirName}-db` }],
    queues: isConsumer
      ? { consumers: [{ queue: queueName.queue }] }
      : { producers: [{ queue: queueName.queue }] },
  };
  const appDir = join(dir, 'apps', dirName);
  mkdirSync(appDir, { recursive: true });
  const path = join(appDir, 'wrangler.jsonc');
  writeFileSync(path, JSON.stringify(config), 'utf8');
  writeLocalWorkerMarker(dir, dirName, isConsumer ? 'log-banner' : 'http-health');
  return path;
}

/**
 * Fake wrangler migration bin (`.sh`, exit 0) — `resolveWranglerInvocation`
 * chạy bin KHÔNG phải `.js` trực tiếp (không qua node), nên shebang + chmod.
 */
function writeFakeMigrationsBin(dir: string): string {
  const path = join(dir, 'fake-wrangler.sh');
  writeFileSync(path, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(path, 0o755);
  return path;
}

/**
 * Fake spawnImpl trả về child object đủ dùng cho `startWorkerProcess`: event
 * emitter rút gọn + stdout/stderr rỗng. Child mô phỏng "spawn thành công rồi
 * sống mãi" hoặc "in banner rồi sống" tùy fixture.
 */

type Handler = (...args: unknown[]) => void;

class FakeChild {
  pid: number;
  stdout: { on(event: string, cb: (chunk: Buffer) => void): void; resume(): void } | null;
  stderr: { on(event: string, cb: (chunk: Buffer) => void): void; resume(): void } | null;
  exited = false;
  exitCode: number | null = null;
  private spawnHandlers: Handler[] = [];
  private exitHandlers: Handler[] = [];

  constructor(options: { pid: number; stdoutBanners?: string[]; stderrBanners?: string[] }) {
    this.pid = options.pid;
    this.stdout = {
      on: (event, cb) => {
        if (event === 'data' && options.stdoutBanners) {
          for (const banner of options.stdoutBanners) cb(Buffer.from(banner, 'utf8'));
        }
      },
      resume: () => undefined,
    };
    this.stderr = {
      on: (event, cb) => {
        if (event === 'data' && options.stderrBanners) {
          for (const banner of options.stderrBanners) cb(Buffer.from(banner, 'utf8'));
        }
      },
      resume: () => undefined,
    };
  }

  on(event: string, cb: Handler): void {
    if (event === 'spawn') {
      this.spawnHandlers.push(cb);
    } else if (event === 'exit') {
      this.exitHandlers.push(cb);
    }
  }

  /** Kích hoạt event mô phỏng — test gọi trực tiếp. */
  emitSpawn(): void {
    for (const handler of this.spawnHandlers) handler();
  }

  emitExit(code: number): void {
    this.exited = true;
    this.exitCode = code;
    for (const handler of this.exitHandlers) handler(code, null);
  }

  /** Kill thật cho fake pid-kill mô phỏng — là no-op, child không phải process thật. */
  kill(): void {
    this.emitExit(0);
  }
}

interface FakeSpawnCapture {
  children: FakeChild[];
  argvs: string[][];
  envs: NodeJS.ProcessEnv[];
  cwds: (string | undefined)[];
}

function fakeSpawnFactory(
  capture: FakeSpawnCapture,
  opts: { pid: number; stdoutBanners?: string[]; stderrBanners?: string[] },
): typeof childSpawn {
  return ((
    _command: string,
    args: string[],
    options_?: { env?: NodeJS.ProcessEnv; cwd?: string },
  ) => {
    const child = new FakeChild(opts);
    capture.children.push(child);
    capture.argvs.push([_command, ...args]);
    capture.envs.push(options_?.env ?? {});
    capture.cwds.push(options_?.cwd);
    // Spawn event bắn trên microtask — sớm hơn assertion/nhưng SAU khi
    // `startWorkerProcess` attach listener (registration là sync). Dùng
    // setTimeout vẫn đúng thật nhưng khi readiness mock của test resolve
    // without macrotask tick thì event không kịp bắn trước assert.
    queueMicrotask(() => child.emitSpawn());
    return child as unknown as ChildProcess;
  }) as unknown as typeof childSpawn;
}

/**
 * Cho readiness HTTP không bao giờ pass với fake child (không server thật),
 * orchestration sẽ teardown; fake child emit exit khi bị stop? — KHÔNG: fake
 * child không liên kết process thật, `handle.stop` sẽ poll isPidAlive(pid
 * giả) — pid giả thường chết thật. Fake pid dùng giá trị PID đã chết chắc
 * chắn (2147483647) → isPidAlive false → stop no-op → teardown không treo.
 */
const DEAD_PID = 2147483647;

describe('MAIL_WORKER_ENTRIES', () => {
  it('discovers a two-mail-worker root in boot order with valid entry names', () => {
    // Fixture worktree có đúng hai app mail (writeCommittedConfig tạo
    // <root>/apps/<name>/wrangler.jsonc + marker) — discovery sống cùng
    // worktree, không scan repo checkout.
    const root = makeWorktreeFixture('entries-happy');
    writeCommittedConfig(root, 'transactional-mail');
    writeCommittedConfig(root, 'transactional-mailer-job');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    writeLocalWorkerMarker(root, 'transactional-mailer-job', 'log-banner');
    const entries = MAIL_WORKER_ENTRIES(root);
    expect(entries.map((entry) => entry.entryName)).toEqual([
      'transactional-mail',
      'transactional-mailer-job',
    ]);
    for (const entry of entries) {
      expect(entry.entryName).toMatch(/^[A-Za-z0-9._-]+$/u);
    }
  });

  it('readiness comes from the marker declaration, never from queues or workers_dev inference', () => {
    // OCR bug-critical trên PR #69: readiness cũ suy từ
    // `consumers.length > 0 && workers_dev === false` — config committed của
    // transactional-mailer-job KHÔNG khai workers_dev (undefined) nên worker
    // queue-only bị suy nhầm http-health rồi poll timeout. Bây giờ readiness
    // là DECLARATION trong marker: cùng shape config, readiness đổi theo
    // marker chứ không theo config.
    const root = makeWorktreeFixture('entries-readiness-declared');
    // Queue-only consumer KHÔNG khai workers_dev (undefined như config thật)
    // — marker vẫn quyết.
    const jobDir = join(root, 'apps', 'transactional-mailer-job');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-transactional-mailer-job',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'mail-job', database_name: 'mail-job' }],
        queues: { consumers: [{ queue: 'ecoma-mail-delivery' }] },
      }),
      'utf8',
    );
    writeLocalWorkerMarker(root, 'transactional-mailer-job', 'log-banner');
    // Producer HTTP khai workers_dev: false (shape như web-push-notification-job)
    // — marker vẫn quyết ngược.
    writeLikelyQueueApp(root, 'transactional-mail', 'ecoma-transactional-mail', {
      queue: 'ecoma-mail-delivery',
    });
    const [control, consumer] = MAIL_WORKER_ENTRIES(root);
    expect(control.readiness.kind).toBe('http-health');
    expect(consumer.readiness.kind).toBe('log-banner');
  });

  it('skips an app whose marker file is absent (Nuxt app keeps its own local path)', () => {
    // OCR bug-high trên PR #69: quét mù mọi wrangler.jsonc nhốt Nuxt app
    // (backoffice, home, pact-broker-app — main trỏ .output/server chưa build,
    // không /health) vào runtime không bao giờ ready. Opt-in marker là gate:
    // app không marker → out khỏi discovery, im lặng không block app khác.
    const root = makeWorktreeFixture('entries-marker-absent');
    writeCommittedConfig(root, 'transactional-mail');
    writeCommittedConfig(root, 'transactional-mailer-job');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    writeLocalWorkerMarker(root, 'transactional-mailer-job', 'log-banner');
    writeCommittedConfig(root, 'backoffice'); // wrangler.jsonc có, marker KHÔNG
    const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
    expect(names).toEqual(['transactional-mail', 'transactional-mailer-job']);
  });

  it('skips an app whose marker readiness value is not one of the declared kinds', () => {
    // Fail-closed cho marker hỏng: app đó out khỏi runtime thay vì fallback
    // readiness ngầm (fallback ngầm chính là bug OCR bug-critical).
    const root = makeWorktreeFixture('entries-marker-bad-value');
    writeCommittedConfig(root, 'transactional-mail');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    writeCommittedConfig(root, 'broken-app');
    const appDir = join(root, 'apps', 'broken-app');
    writeFileSync(join(appDir, 'local-worker.jsonc'), '{"readiness": "tcp-poll"}', 'utf8');
    const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
    expect(names).toEqual(['transactional-mail']);
  });

  it('skips an app whose marker JSON is unparseable (fail-closed, not fallback)', () => {
    const root = makeWorktreeFixture('entries-marker-bad-json');
    writeCommittedConfig(root, 'transactional-mail');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    writeCommittedConfig(root, 'broken-app');
    const appDir = join(root, 'apps', 'broken-app');
    writeFileSync(join(appDir, 'local-worker.jsonc'), '{ readiness: ', 'utf8');
    const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
    expect(names).toEqual(['transactional-mail']);
  });

  it('skips an app whose marker carries unknown keys (single-field contract, no silent ignore)', () => {
    // Contract của marker là readiness declaration DUY NHẤT — key lạ (vd
    // `"path"` tác giả tưởng đổi health path, hay field copy lẫn từ config
    // wrangler) phải fail-loud tại load, không nuốt ngầm.
    const root = makeWorktreeFixture('entries-marker-unknown-key');
    writeCommittedConfig(root, 'transactional-mail');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    writeCommittedConfig(root, 'broken-app');
    const appDir = join(root, 'apps', 'broken-app');
    writeFileSync(
      join(appDir, 'local-worker.jsonc'),
      '{"readiness": "http-health", "path": "/api/health"}\n',
      'utf8',
    );
    const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
    expect(names).toEqual(['transactional-mail']);
  });

  it('warns on stderr when an opted-in app is skipped because its marker cannot load', () => {
    // Fail-closed nhưng quan sát được: marker tồn tại = app chủ động opt-in,
    // lý do rơi ra phải hiện trên stderr (stdout giữ JSON cho status).
    const root = makeWorktreeFixture('entries-marker-bad-json-warn');
    writeCommittedConfig(root, 'transactional-mail');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    writeCommittedConfig(root, 'broken-app');
    const appDir = join(root, 'apps', 'broken-app');
    writeFileSync(join(appDir, 'local-worker.jsonc'), '{ readiness: ', 'utf8');
    const warnSpy = viSpyOnConsoleWarn();
    try {
      const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
      expect(names).toEqual(['transactional-mail']);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('broken-app');
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('local-worker.jsonc');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips an app whose marker path is a directory instead of a file', () => {
    // statSync gate: marker bị tạo nhầm thành thư mục phải đi hành vi
    // "không marker" (skip tĩnh) thay vì EISDIR rơi vào catch chung.
    const root = makeWorktreeFixture('entries-marker-is-dir');
    writeCommittedConfig(root, 'transactional-mail');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    writeCommittedConfig(root, 'broken-app');
    mkdirSync(join(root, 'apps', 'broken-app', 'local-worker.jsonc'), { recursive: true });
    const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
    expect(names).toEqual(['transactional-mail']);
  });

  it('discovers a new app by its committed config and its marker without registration', () => {
    // PR6 contract: app khai wrangler.jsonc + marker = tự động vào runtime.
    const root = makeWorktreeFixture('entries-new-app');
    writeCommittedConfig(root, 'transactional-mail');
    writeCommittedConfig(root, 'transactional-mailer-job');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    writeLocalWorkerMarker(root, 'transactional-mailer-job', 'log-banner');
    // OCR round-2 F8: sample-app phải khai database_name RIÊNG — dùng chung
    // 'mail' như writeCommittedConfig cũ giờ là duplicate database_name
    // fail-closed (mỗi service own data của nó).
    const sampleDir = join(root, 'apps', 'sample-app');
    mkdirSync(sampleDir, { recursive: true });
    writeFileSync(
      join(sampleDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-sample-app',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'sample', database_name: 'sample-db' }],
      }),
      'utf8',
    );
    writeLocalWorkerMarker(root, 'sample-app', 'http-health');
    const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
    expect(names).toContain('sample-app');
  });

  it('fails composition when an app declares more than one D1 database (bridge is single-DB)', () => {
    // Bridge MailWorkerEntry chỉ mang một database; app khai ≥2 `d1_databases`
    // phải fail-loud ở composition thay vì boot với database thứ hai không bao
    // giờ được migrate (`no such table` lúc runtime).
    const root = makeWorktreeFixture('entries-multi-d1');
    const appDir = join(root, 'apps', 'multi-db');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-multi-db',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [
          { binding: 'one', database_name: 'db-one' },
          { binding: 'two', database_name: 'db-two' },
        ],
      }),
      'utf8',
    );
    writeLocalWorkerMarker(root, 'multi-db', 'http-health');
    expect(() => MAIL_WORKER_ENTRIES(root)).toThrow(/hai database|2 D1 database|multi-db/u);
  });

  it('statusWorkerRuntime degrades to standard=false when discovery fails (read-only contract)', () => {
    // statusWorkerRuntime bị gọi cả trong error path của local-worker-up —
    // nếu discovery throw (topology lỗi) thì snapshot phải sống, không exit 1
    // im lặng: degrade standard=false cho mọi row + stderr warn.
    const root = makeWorktreeFixture('status-discovery-fail');
    writeCommittedConfig(root, 'transactional-mail');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    // Consumer khai queue mà không producer nào trong repo → topoSort throw.
    // (helper writeLikelyQueueApp chọn produces/consumers theo `-job` trong
    // tên Worker, nên dùng config consumer tường minh ở đây.)
    writeCommittedConfig(root, 'orphan-consumer-job');
    writeLocalWorkerMarker(root, 'orphan-consumer-job', 'log-banner');
    const orphanDir = join(root, 'apps', 'orphan-consumer-job');
    writeFileSync(
      join(orphanDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-orphan-consumer-job',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'orphan', database_name: 'orphan' }],
        queues: { consumers: [{ queue: 'ecoma-orphan-queue' }] },
      }),
      'utf8',
    );
    // Cài metadata mồ côi stateDir để có row để assert trạng thái degrade.
    const stateDir = join(root, '.worker-local-state');
    mkdirSync(stateDir, { recursive: true });
    const argv = ['/x/wrangler', 'dev', '--config', 'wrangler.jsonc'];
    writeFileSync(
      join(stateDir, 'transactional-mail.json'),
      JSON.stringify({
        version: 1,
        name: 'transactional-mail',
        pid: DEAD_PID,
        argv,
        identityHash: identityHashOf(argv),
        startedAt: Date.now(),
      }),
      'utf8',
    );
    const warnSpy = viSpyOnConsoleWarn();
    try {
      // Tiền đề: riêng discovery phải throw (topology lỗi thật).
      expect(() => MAIL_WORKER_ENTRIES(root)).toThrow(/queue consumer/u);
      const rows = statusWorkerRuntime({ worktreeRoot: root });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.standard).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('discovery fail');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('boot order respects queue dependency (producer before consumer)', () => {
    const root = makeWorktreeFixture('entries-queue-order');
    // push pair thật: control plane produce queue, consumer consume nó.
    writeCommittedConfig(root, 'transactional-mail');
    writeCommittedConfig(root, 'transactional-mailer-job');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    writeLocalWorkerMarker(root, 'transactional-mailer-job', 'log-banner');
    writeLikelyQueueApp(root, 'push-notification', 'ecoma-push-notification', {
      queue: 'ecoma-push-delivery',
    });
    writeLikelyQueueApp(root, 'web-push-notification-job', 'ecoma-web-push-notification-job', {
      queue: 'ecoma-push-delivery',
    });
    const order = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
    expect(order.indexOf('push-notification')).toBeLessThan(
      order.indexOf('web-push-notification-job'),
    );
  });

  it('boot order respects service binding (peer boots first)', () => {
    const root = makeWorktreeFixture('entries-service-order');
    // Mail pair fixture: consumer khai `services[].service` trỏ Worker name
    // `ecoma-transactional-mail` — đúng khớp worker name of producer, và
    // cả hai khai `queues` cùng tên để không orphan queue. Tên `name` bắt
    // buộc `ecoma-` vì service dep đối chiếu worker name, không entry name.
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    writeLocalWorkerMarker(root, 'transactional-mailer-job', 'log-banner');
    const appDir = join(root, 'apps', 'transactional-mail');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-transactional-mail',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'mail', database_name: 'mail' }],
        queues: { producers: [{ queue: 'ecoma-mail-delivery' }] },
      }),
      'utf8',
    );
    const jobDir = join(root, 'apps', 'transactional-mailer-job');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-transactional-mailer-job',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'mail-job', database_name: 'mail-job' }],
        queues: { consumers: [{ queue: 'ecoma-mail-delivery' }] },
        services: [{ binding: 'TRANSACTIONAL_MAIL_SERVICE', service: 'ecoma-transactional-mail' }],
      }),
      'utf8',
    );
    const order = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
    expect(order.indexOf('transactional-mail')).toBeLessThan(
      order.indexOf('transactional-mailer-job'),
    );
  });

  it('fails closed when a consumer queue has no producer in the repo scan', () => {
    const root = makeWorktreeFixture('orphan-queue');
    writeLikelyQueueApp(root, 'web-push-notification-job', 'ecoma-web-push-notification-job', {
      queue: 'ecoma-push-delivery',
    });
    expect(() => MAIL_WORKER_ENTRIES(root)).toThrow(/queue consumer has no producer/u);
  });

  it('exempts a consumed queue declared with an external producer in its marker (lifecycle events)', () => {
    // PR3: `ecoma-mail-lifecycle-events` có producer là Cloudflare Event
    // Subscriptions — cơ chế platform ngoài repo, không bao giờ xuất hiện
    // trong scan. Marker khai external = tuyên bố topology; guard thôi coi
    // là orphan thay vì discovery fail cả repo (bug thật: PR2 thêm consumer
    // lifecycle là `local-worker-status` fail trên main).
    const root = makeWorktreeFixture('orphan-external-producer');
    const jobDir = join(root, 'apps', 'transactional-mailer-job');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-transactional-mailer-job',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'mail-job', database_name: 'mail-job' }],
        queues: { consumers: [{ queue: 'ecoma-mail-lifecycle-events' }] },
      }),
      'utf8',
    );
    writeFileSync(
      join(jobDir, 'local-worker.jsonc'),
      JSON.stringify({
        readiness: 'log-banner',
        external_queue_producers: ['ecoma-mail-lifecycle-events'],
      }),
      'utf8',
    );
    const entries = MAIL_WORKER_ENTRIES(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.externalQueueProducers).toEqual(['ecoma-mail-lifecycle-events']);
  });

  it('fails closed when a queue is declared external AND produced in the repo (contradiction)', () => {
    // Hai declaration mâu thuẫn: guard miễn queue external là tin marker,
    // queue pair thật lại cấp cạnh boot-order — sống chung nghĩa một bên sai
    // mà không ai biết bên nào. Fail-loud buộc gỡ một declaration.
    const root = makeWorktreeFixture('orphan-external-conflict');
    writeLikelyQueueApp(root, 'push-notification', 'ecoma-push-notification', {
      queue: 'ecoma-push-delivery',
    });
    const jobDir = join(root, 'apps', 'consumer-job');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-consumer-job',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'consumer-db' }],
        queues: { consumers: [{ queue: 'ecoma-push-delivery' }] },
      }),
      'utf8',
    );
    writeFileSync(
      join(jobDir, 'local-worker.jsonc'),
      JSON.stringify({
        readiness: 'log-banner',
        external_queue_producers: ['ecoma-push-delivery'],
      }),
      'utf8',
    );
    expect(() => MAIL_WORKER_ENTRIES(root)).toThrow(
      /declared in "external_queue_producers" while also having a producer in the repo: ecoma-push-delivery/u,
    );
  });

  it('still fails closed for an orphan queue that is neither produced nor declared external', () => {
    // Exemption theo danh sách, không phải tắt guard: queue khác không khai
    // external vẫn orphan như cũ.
    const root = makeWorktreeFixture('orphan-unrelated-queue');
    const jobDir = join(root, 'apps', 'consumer-job');
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-consumer-job',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'consumer-db' }],
        queues: {
          consumers: [{ queue: 'ecoma-declared-external' }, { queue: 'ecoma-truly-orphan' }],
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(jobDir, 'local-worker.jsonc'),
      JSON.stringify({
        readiness: 'log-banner',
        external_queue_producers: ['ecoma-declared-external'],
      }),
      'utf8',
    );
    expect(() => MAIL_WORKER_ENTRIES(root)).toThrow(/ecoma-truly-orphan/u);
  });

  it('fails closed when two apps declare the same D1 database_name (services own their data)', () => {
    // OCR round-2 finding F8: `database_name` là định danh object D1 trong
    // persist dir chia sẻ theo worktree — hai app cùng tên là cùng bind MỘT
    // SQLite local (migrations đè nhau, hai service đọc/ghi chung data),
    // vi phạm invariant "services own their data". Phải fail-closed như
    // orphan queue, không boot nửa vời.
    const root = makeWorktreeFixture('entries-duplicate-d1');
    for (const dirName of ['first-service', 'second-service']) {
      const appDir = join(root, 'apps', dirName);
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, 'wrangler.jsonc'),
        JSON.stringify({
          name: `ecoma-${dirName}`,
          main: 'dist/main.js',
          compatibility_date: '2026-10-05',
          d1_databases: [{ binding: 'shared', database_name: 'shared-db' }],
        }),
        'utf8',
      );
      writeLocalWorkerMarker(root, dirName, 'http-health');
    }
    expect(() => MAIL_WORKER_ENTRIES(root)).toThrow(
      /'shared-db' is declared by multiple apps \(first-service, second-service\)/u,
    );
  });

  it('fails closed when two opted-in apps declare the same wrangler worker name', () => {
    // OCR round-2 finding F2: Map `byWorkerName` last-wins im lặng — tên
    // Worker trùng khiến generated config sinh theo worker name ghi đè file
    // của nhau (thư mục generated dùng chung) và service binding neo sai
    // peer. Fail-loud liệt kê cả hai entryNames tại graph build.
    const root = makeWorktreeFixture('entries-duplicate-worker-name');
    for (const dirName of ['first-copy', 'second-copy']) {
      const appDir = join(root, 'apps', dirName);
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, 'wrangler.jsonc'),
        JSON.stringify({
          name: 'ecoma-duplicated-name',
          main: 'dist/main.js',
          compatibility_date: '2026-10-05',
          d1_databases: [{ binding: 'db', database_name: 'dup-db' }],
        }),
        'utf8',
      );
      writeLocalWorkerMarker(root, dirName, 'http-health');
    }
    // Sort alphabet tại scan nên lần chạm thứ hai là 'second-copy'.
    expect(() => MAIL_WORKER_ENTRIES(root)).toThrow(
      /'ecoma-duplicated-name'.*'first-copy'.*'second-copy'/u,
    );
  });

  it('fails closed when a D1 entry misses or misspells database_name (no silent empty string)', () => {
    // OCR round-2 finding F7: `validateCommittedWranglerConfig` không kiểm
    // shape từng d1 entry — thiếu/gõ sai key (`databaseName:` camelCase)
    // lọt xuống bridge thành `''` → app có D1 thật bị coi là "không có D1",
    // migrations bị nhảy im lặng. Fail-loud: throw từ entryFromCommittedConfig
    // → app out khỏi discovery, và lý do quan sát được qua stderr warn
    // (marker tồn tại = app chủ động opt-in) — cùng cơ chế với config hỏng.
    const root = makeWorktreeFixture('entries-d1-missing-name');
    const appDir = join(root, 'apps', 'd1-broken');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-d1-broken',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'mail', databaseName: 'misspelled' }],
      }),
      'utf8',
    );
    writeLocalWorkerMarker(root, 'd1-broken', 'http-health');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
      expect(names).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      const warning = String(spy.mock.calls[0]?.[0]);
      expect(warning).toContain('d1-broken');
      expect(warning).toContain('database_name');
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    {
      picture: 'queues section is a string',
      src: JSON.stringify({
        name: 'ecoma-queues-bad-shape',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'qs-db' }],
        queues: 'ecoma-some-queue',
      }),
    },
    {
      picture: 'queues.producers is an object (not an array)',
      src: JSON.stringify({
        name: 'ecoma-queues-bad-shape',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'qs-db' }],
        queues: { producers: { queue: 'ecoma-some-queue' } },
      }),
    },
    {
      picture: 'queues.consumers is an object (not an array)',
      src: JSON.stringify({
        name: 'ecoma-queues-bad-shape',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'qs-db' }],
        queues: { consumers: { queue: 'ecoma-some-queue' } },
      }),
    },
  ])('fails closed when $picture (no silent empty deps)', ({ src }) => {
    // OCR round-2 finding F9: shape sai của `queues` rơi vào readQueueRefs →
    // trả `[]` NGẦM (fail-OPEN) — deps consumer rỗng làm orphan-queue guard
    // bị bypass (consumer boot, redelivery KHÔNG hoạt động nhưng up báo
    // thành công). Assert tường minh thay vì nhặt rác.
    const root = makeWorktreeFixture('entries-queues-bad-shape');
    const appDir = join(root, 'apps', 'queues-bad-shape');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'wrangler.jsonc'), src, 'utf8');
    writeLocalWorkerMarker(root, 'queues-bad-shape', 'http-health');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // App có marker nên lỗi shape phải khiến nó ra khỏi discovery — nhưng
      // vẫn phải QUAN SÁT ĐƯỢC: stderr warn mang lý do cụ thể (path + shape).
      const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
      expect(names).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      const warning = String(spy.mock.calls[0]?.[0]);
      expect(warning).toContain('queues-bad-shape');
      expect(warning).toMatch(/queues/u);
      expect(warning).toMatch(/must be an? (object|array)/u);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    {
      picture: 'a producers item is null',
      src: JSON.stringify({
        name: 'ecoma-queue-item-null',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'qi-null-db' }],
        queues: { producers: [null] },
      }),
      expectedFragment: /is not an object/u,
    },
    {
      picture: 'a producers item is missing the queue key',
      src: JSON.stringify({
        name: 'ecoma-queue-item-missing-key',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'qi-missing-db' }],
        queues: { producers: [{ exchange: 'ecoma-typo' }] },
      }),
      expectedFragment: /'queue'/u,
    },
    {
      picture: 'a consumers item misspells queue as queu',
      src: JSON.stringify({
        name: 'ecoma-queue-item-typo',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'qi-typo-db' }],
        queues: { consumers: [{ queu: 'ecoma-typo-queue' }] },
      }),
      expectedFragment: /'queue'/u,
    },
  ])(
    'fails closed when $picture (a queue entry cannot silently vanish)',
    ({ src, expectedFragment }) => {
      // OCR round-4 (F2): entry khai queue section nhưng thiếu/sai key `queue`
      // trước đây bị FILTER NGẦM — không đóng góp queue reference ⇒ consumer
      // lọt khỏi orphan-guard và mất cạnh topo-sort. Giờ fail-loud (app out
      // khỏi discovery + stderr warn quan sát được, cùng cơ chế shape khác).
      const root = makeWorktreeFixture('queue-item-bad-shape');
      const appDir = join(root, 'apps', 'queue-item-bad-shape');
      mkdirSync(appDir, { recursive: true });
      writeFileSync(join(appDir, 'wrangler.jsonc'), src, 'utf8');
      writeLocalWorkerMarker(root, 'queue-item-bad-shape', 'http-health');
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
        expect(names).toEqual([]);
        expect(spy).toHaveBeenCalledTimes(1);
        const warning = String(spy.mock.calls[0]?.[0]);
        expect(warning).toContain('queue-item-bad-shape');
        expect(warning).toMatch(/queues\.(producers|consumers)\[\d+\]/u);
        expect(warning).toMatch(expectedFragment);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('fails closed when a d1_databases element is not an object (no opaque TypeError)', () => {
    // OCR round-4 (F3): phần tử không phải object (null/number/...) trước
    // đây ném TypeError opaque từ `.database_name`. Giờ fail-loud với message
    // nêu index + typeof — cùng hình với các shape check khác của module.
    const root = makeWorktreeFixture('d1-element-not-object');
    const appDir = join(root, 'apps', 'd1-element-not-object');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-d1-element-bad',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        // `d1_databases` với phần tử null — JSON.parse cho null (object
        // nhưng typeof null === 'object'), kiểm `=== null` bắt được.
        d1_databases: [null],
      }),
      'utf8',
    );
    writeLocalWorkerMarker(root, 'd1-element-not-object', 'http-health');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
      expect(names).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      const warning = String(spy.mock.calls[0]?.[0]);
      expect(warning).toContain('d1-element-not-object');
      expect(warning).toContain('d1_databases[0]');
      expect(warning).toMatch(/is not an object/u);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    {
      picture: 'a services element is null',
      src: JSON.stringify({
        name: 'ecoma-svc-element-null',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'svc-null-db' }],
        services: [null],
      }),
    },
    {
      picture: 'a services element misses the service key',
      src: JSON.stringify({
        name: 'ecoma-svc-element-missing-key',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'svc-missing-db' }],
        services: [{ binding: 'ecoma-typo' }],
      }),
    },
  ])('fails closed when $picture (no opaque TypeError, no silent drop)', ({ src }) => {
    // OCR round-4 (F4): phần tử services null ném TypeError opaque; phần tử
    // primitive/lacking `service` bị LỌC NGẦM (deps cụt không báo). Giờ cả hai
    // đều fail-loud với index + path.
    const root = makeWorktreeFixture('services-item-bad-shape');
    const appDir = join(root, 'apps', 'services-item-bad-shape');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'wrangler.jsonc'), src, 'utf8');
    writeLocalWorkerMarker(root, 'services-item-bad-shape', 'http-health');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const names = MAIL_WORKER_ENTRIES(root).map((entry) => entry.entryName);
      expect(names).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      const warning = String(spy.mock.calls[0]?.[0]);
      expect(warning).toContain('services-item-bad-shape');
      expect(warning).toMatch(/services\[\d+\]/u);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not infer queue references from the non-standard `exchange` alias key', () => {
    // OCR round-2 finding F5: `exchange` không phải key của wrangler config
    // schema (concept AMQP) — chấp nhận nó như alias là no-inference violation
    // và sai weight của graph. Chỉ đọc `queue`; app dùng key sai thì wrangler
    // dev tự fail validation theo cách rõ.
    const root = makeWorktreeFixture('entries-exchange-alias');
    const producerDir = join(root, 'apps', 'exchange-producer');
    mkdirSync(producerDir, { recursive: true });
    writeFileSync(
      join(producerDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-exchange-producer',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'exchange-db' }],
        queues: { producers: [{ exchange: 'ecoma-never-used' }] },
      }),
      'utf8',
    );
    const consumerDir = join(root, 'apps', 'exchange-consumer');
    mkdirSync(consumerDir, { recursive: true });
    writeFileSync(
      join(consumerDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-exchange-consumer',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'exchange-db2' }],
        queues: { consumers: [{ queue: 'ecoma-real-queue' }] },
      }),
      'utf8',
    );
    writeLocalWorkerMarker(root, 'exchange-producer', 'http-health');
    writeLocalWorkerMarker(root, 'exchange-consumer', 'log-banner');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // OCR round-4 (F2): entry khai queue nhưng thiếu key `queue` giờ
      // FAIL-LOUD (stderr warn) thay vì bị lọc ngầm — app có marker chủ động
      // opt-in nên lỗi shape khiến app ra khỏi discovery. Hệ quả đúng của
      // việc không suy `exchange`: producer biến mất khỏi graph → consumer
      // của `ecoma-real-queue` thành orphan, topo-sort fail-closed với
      // message orphan-consumer (không bao giờ ăn `exchange` làm cạnh thật).
      expect(() => MAIL_WORKER_ENTRIES(root)).toThrow(/queue consumer has no producer/u);
      expect(spy).toHaveBeenCalledTimes(1);
      const warning = String(spy.mock.calls[0]?.[0]);
      expect(warning).toContain('exchange-producer');
      expect(warning).toContain('queues.producers[0]');
      expect(warning).toContain("'queue'");
    } finally {
      spy.mockRestore();
    }
  });

  it('yields an empty runtime with no spawn when discovery finds zero entries', async () => {
    // OCR round-2 finding F6: discovery 0 entry phải được nhìn thấy — cảnh
    // báo thuộc command (`local-worker-up` console.warn), còn orchestration
    // trả rows rỗng KHÔNG lỗi và KHÔNG spawn process nào ("không có gì sống"
    // là trạng thái hợp lệ, exit 0).
    const root = makeWorktreeFixture('entries-zero');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await startWorkerRuntime({
        worktreeRoot: root,
        // Không entry nào → không spawn: spawnImpl nếu được gọi là test fail.
        spawnImpl: (() => {
          throw new Error('unreachable — no entry means no spawn');
        }) as unknown as typeof childSpawn,
      });
      expect(result.workers).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/** Ghi marker opt-in cho app giả `some-app` trong fixture — trả path marker. */
function writeMarker(dir: string, content: string): string {
  const appDir = join(dir, 'apps', 'some-app');
  mkdirSync(appDir, { recursive: true });
  const path = join(appDir, 'local-worker.jsonc');
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('loadWorkerMarkerDeclaration', () => {
  it('parses readiness-only marker into an empty external producers list', () => {
    const root = makeWorktreeFixture('marker-readiness-only');
    const declaration = loadWorkerMarkerDeclaration(
      writeMarker(root, '{"readiness": "log-banner"}'),
    );
    expect(declaration.readiness).toBe('log-banner');
    expect(declaration.externalQueueProducers).toEqual([]);
  });

  it('parses external_queue_producers as a declared list (JSONC comments allowed)', () => {
    const root = makeWorktreeFixture('marker-external');
    const declaration = loadWorkerMarkerDeclaration(
      writeMarker(
        root,
        [
          '{',
          '  // Producer thật là Cloudflare Event Subscriptions — ngoài repo.',
          '  "readiness": "log-banner",',
          '  "external_queue_producers": ["ecoma-mail-lifecycle-events"]',
          '}',
        ].join('\n'),
      ),
    );
    expect(declaration.readiness).toBe('log-banner');
    expect(declaration.externalQueueProducers).toEqual(['ecoma-mail-lifecycle-events']);
  });

  it('rejects an external_queue_producers value that is not an array', () => {
    const root = makeWorktreeFixture('marker-external-not-array');
    expect(() =>
      loadWorkerMarkerDeclaration(
        writeMarker(root, '{"readiness": "log-banner", "external_queue_producers": "q"}'),
      ),
    ).toThrow(/must be an array/u);
  });

  it('rejects an empty string inside external_queue_producers with the index', () => {
    const root = makeWorktreeFixture('marker-external-empty-item');
    expect(() =>
      loadWorkerMarkerDeclaration(
        writeMarker(root, '{"readiness": "log-banner", "external_queue_producers": ["a", ""]}'),
      ),
    ).toThrow(/"external_queue_producers"\[1\]/u);
  });

  it('rejects a duplicate queue inside external_queue_producers', () => {
    const root = makeWorktreeFixture('marker-external-dup');
    expect(() =>
      loadWorkerMarkerDeclaration(
        writeMarker(root, '{"readiness": "log-banner", "external_queue_producers": ["q", "q"]}'),
      ),
    ).toThrow(/twice/u);
  });

  it('still rejects unknown keys now that the contract has two fields (no silent ignore)', () => {
    const root = makeWorktreeFixture('marker-unknown-key-two-field');
    expect(() =>
      loadWorkerMarkerDeclaration(writeMarker(root, '{"readiness": "http-health", "path": "/x"}')),
    ).toThrow(/unknown field/u);
  });

  it('loadReadinessDeclaration keeps returning only the readiness (wrapper contract)', () => {
    const root = makeWorktreeFixture('marker-wrapper');
    const declaration = loadReadinessDeclaration(
      writeMarker(root, '{"readiness": "http-health", "external_queue_producers": ["q"]}'),
    );
    expect(declaration).toBe('http-health');
  });
});

describe('resolveWranglerInvocationArgv', () => {
  it('.js bin resolves to node + script (worker-config rule)', () => {
    const argv = resolveWranglerInvocationArgv('/x/y/wrangler.js');
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toBe('/x/y/wrangler.js');
  });

  it('non-js bin resolves to direct execution (test fixture path)', () => {
    const argv = resolveWranglerInvocationArgv('/x/y/fake-wrangler.sh');
    expect(argv).toEqual(['/x/y/fake-wrangler.sh']);
  });
});

describe('devVarsArgv', () => {
  it('returns --env-file pair when .dev.vars exists in app dir', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'dev-vars-'));
    try {
      writeFileSync(join(appDir, '.dev.vars'), 'MAIL_PROVIDER_KIND=fake\n', 'utf8');
      expect(devVarsArgv(appDir)).toEqual(['--env-file', join(appDir, '.dev.vars')]);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });

  it('returns empty argv when .dev.vars is absent', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'dev-vars-'));
    try {
      expect(devVarsArgv(appDir)).toEqual([]);
    } finally {
      rmSync(appDir, { recursive: true, force: true });
    }
  });
});

describe('portCandidates', () => {
  it('is deterministic ascending from the desired port with 10 candidates', () => {
    expect(portCandidates(20000)).toEqual([
      20000, 20001, 20002, 20003, 20004, 20005, 20006, 20007, 20008, 20009,
    ]);
    expect(portCandidates(20000)).toEqual(portCandidates(20000));
  });
});

describe('localWorkerEnvInjections', () => {
  it('injects BRIDGE_TARGET_ORIGIN for the account-bridge shim pointing at the account container alias', () => {
    const injected = localWorkerEnvInjections('ecoma-account-bridge', 'wtestns123456');
    expect(injected).toEqual({
      BRIDGE_TARGET_ORIGIN: 'http://ecoma-wtestns123456-account:3000',
    });
  });

  it('injects nothing for workers without a local env contract — no implicit env', () => {
    expect(localWorkerEnvInjections('ecoma-transactional-mail', 'wtestns123456')).toEqual({});
    expect(localWorkerEnvInjections('ecoma-anything-else', 'wtestns123456')).toEqual({});
  });

  it('builds a namespace-scoped origin so two worktrees never share an upstream', () => {
    const first = localWorkerEnvInjections('ecoma-account-bridge', 'waaaa1234567');
    const second = localWorkerEnvInjections('ecoma-account-bridge', 'wbbbb7654321');
    expect(first.BRIDGE_TARGET_ORIGIN).not.toBe(second.BRIDGE_TARGET_ORIGIN);
  });
});

describe('startWorkerRuntime', () => {
  it('happy path with fake spawnImpl + fake migrations bin: rows, argv, ports recorded', async () => {
    const root = makeWorktreeFixture('happy');
    for (const name of ['transactional-mail', 'transactional-mailer-job']) {
      writeCommittedConfig(root, name);
      writeLocalWorkerMarker(root, name, name.includes('job') ? 'log-banner' : 'http-health');
    }
    const migrationsBin = writeFakeMigrationsBin(root);

    const capture: FakeSpawnCapture = { children: [], argvs: [], envs: [], cwds: [] };
    // Consumer (entry 2) cần log-banner: stdout banner "Ready on http://...".
    // Entry 1 (control plane) cần HTTP /health — không server thật trong test,
    // nên dùng banner cho CẢ HAI qua stderr fixture... không được: readiness
    // cố định theo entry. Giải pháp: fake child in banner NGAY trên stdout
    // (control plane readiness là HTTP — không đạt → lỗi). Vậy control plane
    // readiness phải bị bỏ qua trong test này — dùng một real HTTP server.
    const banner = 'Ready on http://127.0.0.1:4242';
    const results = [
      new FakeChild({ pid: 4242, stdoutBanners: [banner] }),
      new FakeChild({ pid: 4243, stdoutBanners: [banner] }),
    ];
    let spawnCount = 0;
    const spawnImpl = ((
      _command: string,
      args: string[],
      options_?: { env?: NodeJS.ProcessEnv; cwd?: string },
    ) => {
      const child = results[spawnCount];
      spawnCount += 1;
      capture.argvs.push([_command, ...args]);
      capture.envs.push(options_?.env ?? {});
      capture.cwds.push(options_?.cwd);
      // Cùng quy tắc với fakeSpawnFactory — spawn event trên microtask để
      // pid kịp được ghi trước các assertion (readiness mock resolve không
      // qua macrotask tick nào).
      queueMicrotask(() => child.emitSpawn());
      return child as unknown as ChildProcess;
    }) as unknown as typeof childSpawn;

    // HTTP readiness cho control plane: một server thật trả 200 cho /health,
    // lấy port bất kỳ, rồi patch `dev.port` của generated config về server
    // đó? — orchestration chọn port theo probe+hash trước khi sinh config.
    // Vì thế server phải bind CHÍNH XÁC port orchestration chọn. Cách bền:
    // chạy server trên port 0, rồi cho orchestration dùng namespace hash —
    // không kiểm trước được port. Thay vào đó spawn real server trên port
    // candidate sau khi biết port: dùng hook của orchestration — không có.
    // Cách bền nhất: mock `fetch` toàn cục trả Response.ok trong test này.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    try {
      const result = await startWorkerRuntime({
        worktreeRoot: root,
        wranglerBin: migrationsBin,
        spawnImpl,
      });

      expect(result.workers).toHaveLength(2);
      expect(result.workers[0].entryName).toBe('transactional-mail');
      expect(result.workers[1].entryName).toBe('transactional-mailer-job');
      expect(result.workers[0].pid).toBe(4242);
      expect(result.workers[1].pid).toBe(4243);
      expect(result.workers[0].port).toBeGreaterThan(0);
      expect(result.workers[1].port).toBeGreaterThan(0);
      // Hai port khác nhau (hash theo entry name + scan offset).
      expect(result.workers[0].port).not.toBe(result.workers[1].port);
      // persistTo + configPath theo stateDir của worktree.
      expect(result.persistTo).toBe(join(root, '.worker-local-state'));
      expect(result.workers[0].configPath).toContain(join('.worker-local-state', 'generated'));
      expect(result.namespace).toMatch(/^w[0-9a-f]{12}$/u);

      // Spawn argv: `dev --config <generated> --persist-to <dir> --env-file
      // <app>/.dev.vars?` — KHÔNG có `--port` (generated config đã embed
      // dev.port). Đoạn đuôi env-file phải khớp đúng output của
      // devVarsArgv(appDir) — với existence-driven unit test riêng ở trên.
      for (const argv of capture.argvs) {
        expect(argv[0]).toBe(migrationsBin);
        expect(argv[1]).toBe('dev');
        expect(argv).not.toContain('--port');
        const appDir = capture.cwds[capture.argvs.indexOf(argv)];
        const expectedTail = devVarsArgv(appDir ?? '');
        expect(argv.slice(argv.length - expectedTail.length)).toEqual(expectedTail);
        const configIndex = argv.indexOf('--config');
        expect(configIndex).toBeGreaterThan(0);
        expect(argv[configIndex + 1]).toContain(join('.worker-local-state', 'generated'));
        expect(argv[configIndex + 1]).not.toContain('apps');
        const persistIndex = argv.indexOf('--persist-to');
        expect(persistIndex).toBeGreaterThan(0);
        expect(argv[persistIndex + 1]).toBe(join(root, '.worker-local-state'));
      }
      // Env là allowlist object — KHÔNG bao giờ là process.env nguyên vẹn.
      for (const env of capture.envs) {
        expect(env).not.toBe(process.env);
        expect(env).toHaveProperty('PATH');
      }
      // cwd là app dir của entry.
      expect(capture.cwds[0]).toContain('transactional-mail');
      expect(capture.cwds[1]).toContain('transactional-mailer-job');

      // fetch được gọi cho control plane readiness.
      expect(fetchSpy).toHaveBeenCalled();
      // Fake children không phải process thật — dọn metadata để không rò.
      for (const name of ['transactional-mail', 'transactional-mailer-job']) {
        rmSync(metadataPathOf(join(root, '.worker-local-state'), name), { force: true });
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects up when ANY alive record sits in the stateDir, including one outside current discovery', async () => {
    // OCR round-2 finding F1: discovery là động (marker bị xoá, app dir đổi
    // tên) — runtime cũ sống có thể rơi ra ngoài tập discovered. Guard chỉ
    // lọc theo discovery là mất chặn: HAI bộ `wrangler dev` cùng chạy trên
    // một persist dir + migrants lại trên D1 đang có process mở. Chặn trên
    // MỌI record alive của stateDir.
    const root = makeWorktreeFixture('up-guard-orphan-alive');
    writeCommittedConfig(root, 'transactional-mail');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    // Metadata của entry KHÔNG còn trong discovery ("old-app" — marker đã
    // bị xoá/app dir đổi tên), pid chết chắc chắn (DEAD_PID) nhưng state
    // phải là 'alive' theo scan? — không: isPidAlive(DEAD_PID) fail → stale.
    // Muốn 'alive' thật phải dùng PID SỐNG. Dùng PID của process hiện tại?
    // Không — isPidAlive(process.pid) đúng luôn sống, nhưng pidCmdlineMatches
    // pidTakenOver... trên Linux /proc/pid/cmdline của chính process vitest
    // không khớp argv metadata → classify thành 'stale' (takeover).
    // Giải pháp xác định: spawn một process ĐỒNG SANH giữ alive thật.
    const stateDir = join(root, '.worker-local-state');
    mkdirSync(stateDir, { recursive: true });
    const keeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 28);'], {
      stdio: 'ignore',
      detached: true,
    });
    keeper.unref();
    try {
      // Metadata argv không cần khớp thật — scan chỉ classify alive qua
      // isPidAlive + pidTakenOver (cmdline khác → stale). Tránh takeover:
      // argv[0] trỏ process.execPath (node) — rõ ra là node thật. Đúng shape
      // để readMetadata pass và pidTakenOver match (basename argv[0] = node).
      const argv = [process.execPath, '-e', 'keeper-with-persist'];
      writeFileSync(
        metadataPathOf(stateDir, 'old-app'),
        JSON.stringify({
          version: 1,
          name: 'old-app',
          pid: keeper.pid,
          argv,
          identityHash: identityHashOf(argv),
          startedAt: Date.now(),
        }),
        'utf8',
      );
      // Ổn định liveness: scan classify 'alive' cho record này (cmdline base
      // khớp node).
      const aliveBefore = scanWorkerProcesses(stateDir).filter((e) => e.state === 'alive');
      expect(aliveBefore.map((e) => e.name)).toEqual(['old-app']);
      // 'old-app' KHÔNG nằm trong discovery (chỉ transactional-mail).
      await expect(
        startWorkerRuntime({
          worktreeRoot: root,
          spawnImpl: (() => {
            throw new Error('unreachable — guard must throw before spawn');
          }) as unknown as typeof childSpawn,
        }),
      ).rejects.toThrow(/local worker runtime is already running \(alive: old-app\)/u);
    } finally {
      if (keeper.pid !== undefined) {
        try {
          process.kill(keeper.pid, 'SIGTERM');
        } catch {
          // already gone — best-effort teardown
        }
      }
    }
  });

  it('blocks up on a live runtime before discovery can fail (alive guard runs first)', async () => {
    // OCR round-4 (F1): discovery có thể throw (topology/config sai shape).
    // Nếu discovery chạy TRƯỚC alive-guard, người dùng không bao giờ thấy
    // hướng dẫn dọn runtime cũ, dù một process còn sống đang giữ port +
    // persist dir. Guard phải chặn TRƯỚC, và message phải trỏ đúng lệnh
    // khắc phục (`local-worker-down`).
    const root = makeWorktreeFixture('up-guard-before-discovery');
    // Config SAI SHAPE (queues.producers là object, không phải array) ⇒
    // discovery chắc chắn throw nếu được gọi trước guard.
    const brokenDir = join(root, 'apps', 'broken-shape');
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(
      join(brokenDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'ecoma-broken-shape',
        main: 'dist/main.js',
        compatibility_date: '2026-10-05',
        d1_databases: [{ binding: 'db', database_name: 'broken-db' }],
        queues: { producers: { queue: 'ecoma-some-queue' } },
      }),
      'utf8',
    );
    writeLocalWorkerMarker(root, 'broken-shape', 'http-health');
    const stateDir = join(root, '.worker-local-state');
    mkdirSync(stateDir, { recursive: true });
    const keeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 28);'], {
      stdio: 'ignore',
      detached: true,
    });
    keeper.unref();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const argv = [process.execPath, '-e', 'keeper-with-persist'];
      writeFileSync(
        metadataPathOf(stateDir, 'old-app'),
        JSON.stringify({
          version: 1,
          name: 'old-app',
          pid: keeper.pid,
          argv,
          identityHash: identityHashOf(argv),
          startedAt: Date.now(),
        }),
        'utf8',
      );
      await expect(
        startWorkerRuntime({
          worktreeRoot: root,
          spawnImpl: (() => {
            throw new Error('unreachable — guard must throw before spawn');
          }) as unknown as typeof childSpawn,
        }),
      ).rejects.toThrow(/local worker runtime is already running \(alive: old-app\)/u);
    } finally {
      warnSpy.mockRestore();
      if (keeper.pid !== undefined) {
        try {
          process.kill(keeper.pid, 'SIGTERM');
        } catch {
          // already gone — best-effort teardown
        }
      }
    }
  });

  it('redistributes the port when a real server holds the desired port busy', async () => {
    const root = makeWorktreeFixture('port-busy');
    for (const name of ['transactional-mail', 'transactional-mailer-job']) {
      writeCommittedConfig(root, name);
      writeLocalWorkerMarker(root, name, name.includes('job') ? 'log-banner' : 'http-health');
    }
    const migrationsBin = writeFakeMigrationsBin(root);

    // Compute the desired port the same way orchestration does (namespace +
    // entryName hash) so we can hold exactly that port with a real server.
    const { allocateWorkerPort } = await import('./worker-config.js');
    const normalized = normalizeWorktreeRoot(root);
    const namespace = worktreeNamespace(normalized);
    const desired = allocateWorkerPort(namespace, 'transactional-mail');

    const holder = createServer();
    await new Promise<void>((resolve) => {
      holder.listen(desired, '127.0.0.1', () => resolve());
    });

    const capture: FakeSpawnCapture = { children: [], argvs: [], envs: [], cwds: [] };
    const banner = 'Ready on http://';
    const spawnImpl = fakeSpawnFactory(capture, { pid: DEAD_PID, stdoutBanners: [banner] });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    try {
      const result = await startWorkerRuntime({
        worktreeRoot: root,
        wranglerBin: migrationsBin,
        spawnImpl,
      });
      // control plane KHÔNG nhận desired port — port bị holder giữ, scan
      // offset kế tiếp phải được chọn.
      expect(result.workers[0].port).not.toBe(desired);
      expect(result.workers[0].port).toBe(desired + 1);
      // Consumer dùng port hash riêng của nó — không đụng desired.
      const desiredJob = allocateWorkerPort(namespace, 'transactional-mailer-job');
      expect(result.workers[1].port).toBe(desiredJob);
      for (const name of ['transactional-mail', 'transactional-mailer-job']) {
        rmSync(metadataPathOf(join(root, '.worker-local-state'), name), { force: true });
      }
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolve, reject) => {
        holder.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('migration errors propagate (fail-closed) without spawning anything', async () => {
    const root = makeWorktreeFixture('migration-fail');
    for (const name of ['transactional-mail', 'transactional-mailer-job']) {
      writeCommittedConfig(root, name);
      writeLocalWorkerMarker(root, name, name.includes('job') ? 'log-banner' : 'http-health');
    }
    // Fake bin exit 3 → runWrangler throw.
    const failingBin = join(root, 'failing-wrangler.sh');
    writeFileSync(failingBin, '#!/bin/sh\necho "boom migration" >&2\nexit 3\n', 'utf8');
    chmodSync(failingBin, 0o755);

    const capture: FakeSpawnCapture = { children: [], argvs: [], envs: [], cwds: [] };
    const spawnImpl = fakeSpawnFactory(capture, { pid: DEAD_PID });

    await expect(
      startWorkerRuntime({ worktreeRoot: root, wranglerBin: failingBin, spawnImpl }),
    ).rejects.toThrow(/boom migration/u);
    // Fail-closed: KHÔNG spawn process nào khi migration chưa pass.
    expect(capture.children).toHaveLength(0);
  });

  it('readiness timeout stops the child, removes metadata and throws with tail', async () => {
    const root = makeWorktreeFixture('readiness-timeout');
    for (const name of ['transactional-mail', 'transactional-mailer-job']) {
      writeCommittedConfig(root, name);
      writeLocalWorkerMarker(root, name, name.includes('job') ? 'log-banner' : 'http-health');
    }
    const migrationsBin = writeFakeMigrationsBin(root);

    const capture: FakeSpawnCapture = { children: [], argvs: [], envs: [], cwds: [] };
    // Fake child in stderr tail đặc trưng — error message phải chứa nó.
    const spawnImpl = fakeSpawnFactory(capture, {
      pid: DEAD_PID,
      stderrBanners: ['ECONNREFUSED workerd crashed early'],
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('connection refused'));

    try {
      await expect(
        startWorkerRuntime({
          worktreeRoot: root,
          wranglerBin: migrationsBin,
          spawnImpl,
          readiness: { pollIntervalMs: 20, timeoutMs: 120 },
        }),
      ).rejects.toThrow(/transactional-mail.*never became ready/u);
      // Metadata bị dọn sau teardown — không còn entry nào trong stateDir.
      const scan = scanWorkerProcesses(join(root, '.worker-local-state'));
      expect(scan).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('stopWorkerRuntime', () => {
  it('terminates a REAL long-lived child spawned through the real spawn path', async () => {
    const root = makeWorktreeFixture('down-real-kill');
    const stateDir = join(root, '.worker-local-state');
    // startWorkerProcess không mkdir stateDir — spec của worker-process cũng
    // dùng mkdtemp dir làm stateDir sẵn. Tạo tương ứng ở đây.
    mkdirSync(stateDir, { recursive: true });
    const { startWorkerProcess } = await import('./worker-process.js');
    const args = [
      process.execPath,
      '-e',
      'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1 << 28);',
    ];
    const handle = startWorkerProcess({
      name: 'real-child',
      argv: args,
      cwd: root,
      env: {},
      stateDir,
    });
    const deadline = Date.now() + 5000;
    while (handle.pid < 0 && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    expect(handle.pid).toBeGreaterThan(0);

    const report = await stopWorkerRuntime({ worktreeRoot: root });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      name: 'real-child',
      before: 'alive',
      action: 'terminated',
    });

    // PID thật phải chết sau stop — không để orphan.
    const gone = await waitForPidGone(handle.pid, 5000);
    expect(gone).toBe(true);
    // Metadata cũng đã dọn (down path dọn luôn file sau kill? — theo thiết kế
    // killWorkerProcessByMetadata chỉ kill; scan sau stop không còn file là
    // điều kỳ vọng của down: check bằng scan).
    const scanAfter = scanWorkerProcesses(stateDir);
    expect(scanAfter.find((entry) => entry.name === 'real-child')).toBeUndefined();
  });

  it('cleans stale/unspawned metadata and keeps invalid as evidence', async () => {
    const root = makeWorktreeFixture('down-cleanup');
    const stateDir = join(root, '.worker-local-state');
    mkdirSync(stateDir, { recursive: true });
    // stale: pid chết, identity đầy đủ.
    const staleArgs = [process.execPath, 'gone.js'];
    writeFileSync(
      metadataPathOf(stateDir, 'stale-worker'),
      JSON.stringify({
        version: 1,
        name: 'stale-worker',
        pid: 2147483647,
        argv: staleArgs,
        identityHash: identityHashOf(staleArgs),
        startedAt: 1,
      }),
      'utf8',
    );
    // unspawned: pid 0 shape hợp lệ.
    const unspawnedArgs = [process.execPath, 'unspawned.js'];
    writeFileSync(
      metadataPathOf(stateDir, 'unspawned-worker'),
      JSON.stringify({
        version: 1,
        name: 'unspawned-worker',
        pid: 0,
        argv: unspawnedArgs,
        identityHash: identityHashOf(unspawnedArgs),
        startedAt: 2,
      }),
      'utf8',
    );
    // invalid: file hỏng.
    writeFileSync(metadataPathOf(stateDir, 'corrupt-worker'), '{bad', 'utf8');

    const report = await stopWorkerRuntime({ worktreeRoot: root });
    const byName = new Map(report.rows.map((row) => [row.name, row]));
    expect(byName.get('stale-worker')).toMatchObject({
      before: 'stale',
      action: 'cleaned-metadata',
    });
    expect(byName.get('unspawned-worker')).toMatchObject({
      before: 'unspawned',
      action: 'cleaned-metadata',
    });
    expect(byName.get('corrupt-worker')).toMatchObject({
      before: 'invalid',
      action: 'kept-evidence',
    });
    expect(existsSync(metadataPathOf(stateDir, 'stale-worker'))).toBe(false);
    expect(existsSync(metadataPathOf(stateDir, 'unspawned-worker'))).toBe(false);
    expect(existsSync(metadataPathOf(stateDir, 'corrupt-worker'))).toBe(true);
  });

  it('is idempotent when nothing is up (empty rows, no error)', async () => {
    const root = makeWorktreeFixture('down-empty');
    const report = await stopWorkerRuntime({ worktreeRoot: root });
    expect(report.rows).toEqual([]);
  });
});

describe('statusWorkerRuntime', () => {
  it('returns read-only rows reflecting injected states', async () => {
    const root = makeWorktreeFixture('status-rows');
    const stateDir = join(root, '.worker-local-state');
    mkdirSync(stateDir, { recursive: true });
    // `standard` của PR6 là "entry name nằm trong discovery của worktree" —
    // fixture phải khai app đúng tên trong apps/ thì row mới chuẩn.
    writeCommittedConfig(root, 'transactional-mail');
    writeLocalWorkerMarker(root, 'transactional-mail', 'http-health');
    const args = [process.execPath, 'x.js'];
    writeFileSync(
      metadataPathOf(stateDir, 'transactional-mail'),
      JSON.stringify({
        version: 1,
        name: 'transactional-mail',
        pid: 999,
        argv: args,
        identityHash: identityHashOf(args),
        startedAt: 1234,
      }),
      'utf8',
    );
    writeFileSync(metadataPathOf(stateDir, 'broken'), 'not json', 'utf8');

    const rows = statusWorkerRuntime({ worktreeRoot: root });
    expect(rows).toHaveLength(2);
    const standard = rows.find((row) => row.name === 'transactional-mail');
    expect(standard).toMatchObject({
      state: 'stale',
      pid: 999,
      startedAt: 1234,
      generatedConfigExists: false,
      standard: true,
    });
    const broken = rows.find((row) => row.name === 'broken');
    expect(broken).toMatchObject({ state: 'invalid', pid: null, startedAt: null, standard: false });
  });
});

function waitForPidGone(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      try {
        process.kill(pid, 0);
      } catch {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}
