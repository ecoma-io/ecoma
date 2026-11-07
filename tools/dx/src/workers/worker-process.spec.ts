/**
 * Spec của `worker-process.ts` — vòng đời process Worker local.
 *
 * Test giữ unit-test nhanh và deterministic: dùng process thật `node -e` (argv
 * array an toàn, không shell-string) hoặc `spawnImpl` fake cho kịch bản lỗi.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deleteStaleWorkerMetadata,
  identityHashOf,
  isPidAlive,
  killWorkerProcessByMetadata,
  metadataPathOf,
  pidCmdlineMatches,
  readMetadata,
  sameIdentity,
  scanWorkerProcesses,
  startWorkerProcess,
  terminateStaleWorker,
  WORKER_STATE_DIR_NAME,
  workerProcessStateDir,
} from './worker-process.js';

const cleanup: string[] = [];

/** Poll `check()` tới khi true hoặc hết `timeoutMs` — dùng cho event async. */
function waitForCondition(check: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (check()) {
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

/**
 * Probe TCP `127.0.0.1:<targetPort>` — port-bound readiness for tests (PID
 * liveness proves nothing about a listener), and release check after stop.
 */
const probePort = (targetPort: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect(targetPort, '127.0.0.1');
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

function cleanStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worker-process-spec-'));
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

describe('identityHashOf / sameIdentity', () => {
  it('argv same order → sameIdentity true, different argv → false', () => {
    const a = [process.execPath, '--foo', 'bar'];
    const b = [process.execPath, '--foo', 'bar'];
    const c = [process.execPath, 'bar', '--foo'];
    expect(sameIdentity(a, b)).toBe(true);
    expect(sameIdentity(a, c)).toBe(false);
    expect(sameIdentity(a, [])).toBe(false);
  });

  it('identityHash stable for identical argv, differs for changed argv', () => {
    const base = [process.execPath, 'cli.js', '--port', '8899'];
    const changed = [process.execPath, 'cli.js', '--port', '8898'];
    expect(identityHashOf(base)).toBe(identityHashOf([...base]));
    expect(identityHashOf(base)).not.toBe(identityHashOf(changed));
    expect(identityHashOf(base)).toHaveLength(16);
  });
});

describe('readMetadata', () => {
  it('returns null for nonexistent or corrupt file', () => {
    expect(readMetadata(join(tmpdir(), 'does-not-exist.json'))).toBeNull();
    const dir = cleanStateDir();
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{not-json', 'utf8');
    expect(readMetadata(path)).toBeNull();
  });

  it('returns null when pid nonpositive', () => {
    const dir = cleanStateDir();
    const args = [process.execPath, '--flag'];
    const base = {
      version: 1,
      name: 'x',
      argv: args,
      identityHash: identityHashOf(args),
      startedAt: 111,
    };
    for (const pid of [0, -7]) {
      const path = join(dir, `pid-${pid}.json`);
      writeFileSync(path, JSON.stringify({ ...base, pid }), 'utf8');
      expect(readMetadata(path)).toBeNull();
    }
  });

  it('returns null when argv empty or missing identityHash', () => {
    const dir = cleanStateDir();
    const path = join(dir, 'empty.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        name: 'x',
        pid: 999,
        argv: [],
        identityHash: 'abc',
        startedAt: 1,
      }),
      'utf8',
    );
    expect(readMetadata(path)).toBeNull();
    const path2 = join(dir, 'nohash.json');
    writeFileSync(
      path2,
      JSON.stringify({ version: 1, name: 'x', pid: 999, argv: ['node'], startedAt: 1 }),
      'utf8',
    );
    expect(readMetadata(path2)).toBeNull();
  });

  it('accepts a well-formed metadata record', () => {
    const dir = cleanStateDir();
    const path = join(dir, 'good.json');
    const args = [process.execPath, 'main.js'];
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        name: 'worker',
        pid: 123,
        argv: args,
        identityHash: identityHashOf(args),
        startedAt: 42,
      }),
      'utf8',
    );
    const parsed = readMetadata(path);
    expect(parsed).not.toBeNull();
    expect(parsed?.pid).toBe(123);
    expect(parsed?.argv).toEqual(args);
    expect(parsed?.version).toBe(1);
  });
});

describe('isPidAlive', () => {
  it('current process alive; invalid pid treated dead', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-9)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });
});

describe('startWorkerProcess', () => {
  it('failed startup (ENOENT): spawnError surfaces, identity metadata stays readable', async () => {
    const dir = cleanStateDir();
    const args = ['definitely-not-a-binary-12345', '--flag'];
    const handle = startWorkerProcess({
      name: 'spawn-fail',
      argv: args,
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    const deadline = Date.now() + 3000;
    while (handle.spawnError === undefined && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    expect(handle.spawnError).toBeDefined();
    expect(handle.spawnError).toContain('ENOENT');
    expect(handle.exited).toBe(false);
    // pid=0 record survive — caller không kill nhầm điều gì (pid 0 bị loader từ chối).
    const raw = readFileSync(handle.metadataPath, 'utf8');
    const meta = JSON.parse(raw) as { pid: number; identityHash: string; argv: string[] };
    expect(meta.pid).toBe(0);
    expect(meta.identityHash).toBe(identityHashOf(args));
    expect(meta.argv).toEqual(args);
    handle.removeMetadata();
    expect(existsSync(handle.metadataPath)).toBe(false);
  });

  it('early exit: handle captures exit code and resolves onExit', async () => {
    const dir = cleanStateDir();
    const args = [process.execPath, '-e', 'process.exit(7)'];
    const handle = startWorkerProcess({
      name: 'early-exit',
      argv: args,
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    await handle.onExit;
    expect(handle.exited).toBe(true);
    expect(handle.exitCode).toBe(7);
    handle.removeMetadata();
  });

  it('stale metadata detection: identity mismatch rejects kill intent', () => {
    const dir = cleanStateDir();
    const staleArgs = [process.execPath, 'irrelevant.js'];
    const metaPath = metadataPathOf(dir, 'stale');
    writeFileSync(
      metaPath,
      JSON.stringify({
        version: 1,
        name: 'stale',
        pid: process.pid, // pid reuse by an unrelated live process
        argv: staleArgs,
        identityHash: identityHashOf(staleArgs),
        startedAt: 1,
      }),
      'utf8',
    );
    const meta = readMetadata(metaPath);
    expect(meta).not.toBeNull();
    expect(meta?.pid).toBe(process.pid);
    // Caller muốn kill với argv khác → identity mismatch → không kill.
    const killIntent = [process.execPath, 'other.js'];
    expect(sameIdentity(meta?.argv ?? [], killIntent)).toBe(false);
    // Caller kill với argv khớp → identity match → được phép.
    expect(sameIdentity(staleArgs, meta?.argv ?? [])).toBe(true);
  });

  it('shutdown (SIGTERM): terminates a long-running process', async () => {
    const dir = cleanStateDir();
    const handle = startWorkerProcess({
      name: 'term-target',
      argv: [
        process.execPath,
        '-e',
        'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1 << 28);',
      ],
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    const deadline = Date.now() + 5000;
    while (!handle.alive() && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    expect(handle.alive()).toBe(true);
    await handle.stop(2000);
    expect(handle.alive()).toBe(false);
    handle.removeMetadata();
  });

  it('shutdown is a no-op for a process that already exited', async () => {
    const dir = cleanStateDir();
    const handle = startWorkerProcess({
      name: 'already-exited',
      argv: [process.execPath, '-e', 'process.exit(5)'],
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    await handle.onExit;
    expect(handle.exited).toBe(true);
    await handle.stop(100);
    expect(handle.exitCode).toBe(5);
    handle.removeMetadata();
  });

  it('stop escalates to SIGKILL after timeout for a process ignoring SIGTERM', async () => {
    const dir = cleanStateDir();
    const handle = startWorkerProcess({
      name: 'sigterm-ignore',
      argv: [
        process.execPath,
        '-e',
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1 << 28);',
      ],
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    const deadline = Date.now() + 5000;
    while (!handle.alive() && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    expect(handle.alive()).toBe(true);
    await handle.stop(200);
    expect(handle.alive()).toBe(false);
    handle.removeMetadata();
  });

  it('port conflict: second process exits non-zero when port already bound', async () => {
    const dir = cleanStateDir();
    const port = 49000 + Math.floor(Math.random() * 1000);
    const script = `const net=require('node:net');const s=net.createServer();s.on('error',()=>process.exit(98));s.listen(${port},'127.0.0.1');setInterval(()=>{},1<<28);`;
    const holder = startWorkerProcess({
      name: 'port-holder',
      argv: [process.execPath, '-e', script],
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    // Deterministically wait until the port is actually bound (TCP connect succeeds),
    // not just until the holder PID is alive.
    const bindDeadline = Date.now() + 5000;
    let bound = false;
    while (!bound && Date.now() < bindDeadline) {
      bound = await probePort(port);
      if (!bound) {
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
    }
    expect(bound).toBe(true);
    expect(holder.alive()).toBe(true);

    const second = startWorkerProcess({
      name: 'port-conflict',
      argv: [process.execPath, '-e', script],
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    const conflictDeadline = Date.now() + 5000;
    while (!second.exited && Date.now() < conflictDeadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    expect(second.exited).toBe(true);
    expect(second.exitCode).not.toBe(0);
    await holder.stop(1000);
    holder.removeMetadata();
    second.removeMetadata();
    // Best-effort: confirm port released, but do not fail the test on it.
    const releaseDeadline = Date.now() + 2000;
    let released = false;
    while (!released && Date.now() < releaseDeadline) {
      released = !(await probePort(port));
      if (!released) {
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
    }
  });

  it('timeout: handle.onExit does not resolve before process exits (no premature resolve)', async () => {
    const dir = cleanStateDir();
    const handle = startWorkerProcess({
      name: 'timeout-target',
      argv: [process.execPath, '-e', 'setTimeout(() => process.exit(0), 50);'],
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    let resolved = false;
    const promise = handle.onExit.then(() => {
      resolved = true;
      return undefined;
    });
    // Ngay sau start, process chưa exit → onExit chưa resolve.
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(resolved).toBe(false);
    await promise;
    expect(resolved).toBe(true);
    handle.removeMetadata();
  });

  it('state dir path convention is .worker-local-state under root', () => {
    expect(WORKER_STATE_DIR_NAME).toBe('.worker-local-state');
    expect(workerProcessStateDir('/tmp/worktree')).toBe('/tmp/worktree/.worker-local-state');
  });
});

describe('scanWorkerProcesses / deleteStaleWorkerMetadata / terminateStaleWorker', () => {
  it('scan classifies alive vs stale vs invalid', async () => {
    const dir = cleanStateDir();
    const aliveArgs = [process.execPath, '-e', 'setInterval(() => {}, 1 << 28)'];
    const handle = startWorkerProcess({
      name: 'alive',
      argv: aliveArgs,
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    // wait spawn
    const deadline = Date.now() + 5000;
    while (handle.pid < 0 && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    // write stale entry with dead pid
    const deadPid = 2147483647;
    writeFileSync(
      metadataPathOf(dir, 'stale'),
      JSON.stringify({
        version: 1,
        name: 'stale',
        pid: deadPid,
        argv: [process.execPath, 'stale.js'],
        identityHash: identityHashOf([process.execPath, 'stale.js']),
        startedAt: 1,
      }),
      'utf8',
    );
    // invalid: corrupt + pid 0
    writeFileSync(metadataPathOf(dir, 'corrupt'), '{bad', 'utf8');
    writeFileSync(
      metadataPathOf(dir, 'zero'),
      JSON.stringify({
        version: 1,
        name: 'zero',
        pid: 0,
        argv: [process.execPath, 'z.js'],
        identityHash: 'x',
        startedAt: 1,
      }),
      'utf8',
    );

    const scan = scanWorkerProcesses(dir);
    const byName = new Map(scan.map((e) => [e.name, e.state]));
    expect(byName.get('alive')).toBe('alive');
    expect(byName.get('stale')).toBe('stale');
    expect(byName.get('corrupt')).toBe('invalid');
    expect(byName.get('zero')).toBe('invalid');

    // deleteStale keeps alive + invalid, removes stale
    const report = deleteStaleWorkerMetadata(dir);
    expect(report.removed).toContain('stale');
    expect(report.kept).toContain('alive');
    expect(report.kept).toContain('corrupt');
    expect(report.kept).toContain('zero');
    expect(existsSync(metadataPathOf(dir, 'stale'))).toBe(false);
    expect(existsSync(metadataPathOf(dir, 'alive'))).toBe(true);
    expect(existsSync(metadataPathOf(dir, 'corrupt'))).toBe(true);

    handle.stop(1000).then(() => handle.removeMetadata());
  });

  it('terminateStaleWorker refuses when identity mismatches or pid alive', () => {
    const dir = cleanStateDir();
    const args = [process.execPath, 'worker.js'];
    writeFileSync(
      metadataPathOf(dir, 'entry'),
      JSON.stringify({
        version: 1,
        name: 'entry',
        pid: process.pid,
        argv: args,
        identityHash: identityHashOf(args),
        startedAt: 1,
      }),
      'utf8',
    );
    // pid alive → null
    expect(terminateStaleWorker(dir, 'entry', args)).toBeNull();
    // identity mismatch even with dead pid: rewrite dead pid
    writeFileSync(
      metadataPathOf(dir, 'entry2'),
      JSON.stringify({
        version: 1,
        name: 'entry2',
        pid: 2147483647,
        argv: args,
        identityHash: identityHashOf(args),
        startedAt: 1,
      }),
      'utf8',
    );
    expect(terminateStaleWorker(dir, 'entry2', [process.execPath, 'other.js'])).toBeNull();
    // corrupt metadata → null
    writeFileSync(metadataPathOf(dir, 'entry3'), '{bad', 'utf8');
    expect(terminateStaleWorker(dir, 'entry3', args)).toBeNull();
    // missing metadata → null
    expect(terminateStaleWorker(dir, 'nope', args)).toBeNull();
  });

  it('terminateStaleWorker sends SIGTERM when stale + identity matches', () => {
    const dir = cleanStateDir();
    const args = [process.execPath, 'worker.js'];
    // pid dead + identity match → true (SIGTERM sent to dead pid ⇒ ESRCH ⇒ treated as done)
    writeFileSync(
      metadataPathOf(dir, 'dead'),
      JSON.stringify({
        version: 1,
        name: 'dead',
        pid: 2147483647,
        argv: args,
        identityHash: identityHashOf(args),
        startedAt: 1,
      }),
      'utf8',
    );
    expect(terminateStaleWorker(dir, 'dead', args)).toBe(true);
  });

  it('scan on nonexistent dir returns empty', () => {
    const dir = join(tmpdir(), 'no-such-worker-state-' + Date.now());
    expect(scanWorkerProcesses(dir)).toEqual([]);
    const r = deleteStaleWorkerMetadata(dir);
    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('unspawned metadata (valid shape, pid 0) is classified and removed; invalid preserved', () => {
    const dir = cleanStateDir();
    const args = [process.execPath, 'unspawned.js'];
    // pid=0 valid shape — spawn failed before 'spawn' event.
    writeFileSync(
      metadataPathOf(dir, 'unspawned'),
      JSON.stringify({
        version: 1,
        name: 'unspawned',
        pid: 0,
        argv: args,
        identityHash: identityHashOf(args),
        startedAt: 1,
      }),
      'utf8',
    );
    // pid=-7 same shape — also unspawned family (pid<=0 valid record).
    writeFileSync(
      metadataPathOf(dir, 'negative'),
      JSON.stringify({
        version: 1,
        name: 'negative',
        pid: -3,
        argv: args,
        identityHash: identityHashOf(args),
        startedAt: 1,
      }),
      'utf8',
    );
    // pid=0 but identityHash mismatch — corrupt, must stay 'invalid'.
    writeFileSync(
      metadataPathOf(dir, 'corrupt-hash'),
      JSON.stringify({
        version: 1,
        name: 'corrupt-hash',
        pid: 0,
        argv: args,
        identityHash: 'deadbeef',
        startedAt: 1,
      }),
      'utf8',
    );

    const scan = scanWorkerProcesses(dir);
    const byName = new Map(scan.map((e) => [e.name, e.state]));
    expect(byName.get('unspawned')).toBe('unspawned');
    expect(byName.get('negative')).toBe('unspawned');
    expect(byName.get('corrupt-hash')).toBe('invalid');

    // Both unspawned entries get removed; corrupt-hash (invalid) is kept.
    const report = deleteStaleWorkerMetadata(dir);
    expect(report.removed).toContain('unspawned');
    expect(report.removed).toContain('negative');
    expect(report.kept).toContain('corrupt-hash');
    expect(existsSync(metadataPathOf(dir, 'unspawned'))).toBe(false);
    expect(existsSync(metadataPathOf(dir, 'negative'))).toBe(false);
    expect(existsSync(metadataPathOf(dir, 'corrupt-hash'))).toBe(true);
  });

  it('safe unlink: metadata overwritten between scan and delete is NOT removed', async () => {
    const dir = cleanStateDir();
    const stalePid = 2147483647;
    const freshArgs = [process.execPath, 'fresh.js'];
    writeFileSync(
      metadataPathOf(dir, 'race'),
      JSON.stringify({
        version: 1,
        name: 'race',
        pid: stalePid,
        argv: [process.execPath, 'victim.js'],
        identityHash: identityHashOf([process.execPath, 'victim.js']),
        startedAt: 1,
      }),
      'utf8',
    );

    // Spawn a real live worker after scan starts... simpler: mutate file between
    // scan and delete by intercepting — vi phạm black-box nếu can thiệp nội bộ.
    // Cách kiểm chứng: scan → overwrite file (mô phỏng spawn mới ghi metadata
    // giống thật) → deleteStaleWorkerMetadata phải giữ lại file mới.
    void scanWorkerProcesses(dir);

    // Overwrite thành metadata của process sống (pid thật) — mô phỏng một spawn
    // mớiပ đã ghi đè file giữa scan và delete.
    const newLiveMeta = {
      version: 1,
      name: 'race',
      pid: process.pid, // alive
      argv: freshArgs,
      identityHash: identityHashOf(freshArgs),
      startedAt: 2,
    };
    writeFileSync(metadataPathOf(dir, 'race'), JSON.stringify(newLiveMeta), 'utf8');

    const report = deleteStaleWorkerMetadata(dir);
    // Snapshot stale không khớp nội dung mới → không xoá — file sống được giữ.
    expect(report.removed).toEqual([]);
    expect(report.kept).toContain('race');
    expect(existsSync(metadataPathOf(dir, 'race'))).toBe(true);
  });

  it('startWorkerProcess rejects overwriting live metadata (same or different identity)', async () => {
    const dir = cleanStateDir();
    const args = [process.execPath, '-e', 'setInterval(() => {}, 1 << 28)'];
    const handle = startWorkerProcess({
      name: 'dup',
      argv: args,
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    const deadline = Date.now() + 5000;
    while (handle.pid < 0 && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    expect(handle.pid).toBeGreaterThan(0);

    // Same identity, live pid → rejected.
    expect(() =>
      startWorkerProcess({ name: 'dup', argv: args, cwd: dir, env: {}, stateDir: dir }),
    ).toThrow(/already running/u);

    // Different identity, live pid → rejected with identity mismatch.
    expect(() =>
      startWorkerProcess({
        name: 'dup',
        argv: [process.execPath, 'other.js'],
        cwd: dir,
        env: {},
        stateDir: dir,
      }),
    ).toThrow(/identity/u);

    // Dead pid metadata → overwrite allowed.
    writeFileSync(
      metadataPathOf(dir, 'dead-entry'),
      JSON.stringify({
        version: 1,
        name: 'dead-entry',
        pid: 2147483647,
        argv: [process.execPath, 'old.js'],
        identityHash: identityHashOf([process.execPath, 'old.js']),
        startedAt: 1,
      }),
      'utf8',
    );
    const resumed = startWorkerProcess({
      name: 'dead-entry',
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1 << 28)'],
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    const resumedDeadline = Date.now() + 5000;
    while (resumed.pid < 0 && Date.now() < resumedDeadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    expect(resumed.pid).toBeGreaterThan(0);
    await resumed.stop(1000);
    resumed.removeMetadata();
    await handle.stop(1000);
    handle.removeMetadata();
  });

  it('startWorkerProcess overwrites metadata whose pid was recycled by an unrelated process', async () => {
    const dir = cleanStateDir();
    // Metadata cho pid đang sống thật (current process) nhưng argv là binary
    // khác (wrangler-like) — /proc/cmdline (node) không chứa basename đó →
    // phân loại takeover, cho phép ghi đè recovery.
    writeFileSync(
      metadataPathOf(dir, 'recycled'),
      JSON.stringify({
        version: 1,
        name: 'recycled',
        pid: process.pid,
        argv: ['/opt/cloudflare/wrangler', 'dev'],
        identityHash: identityHashOf(['/opt/cloudflare/wrangler', 'dev']),
        startedAt: 1,
      }),
      'utf8',
    );
    const handle = startWorkerProcess({
      name: 'recycled',
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1 << 28)'],
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    const deadline = Date.now() + 5000;
    while (handle.pid < 0 && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    expect(handle.pid).toBeGreaterThan(0);
    await handle.stop(1000);
    handle.removeMetadata();
  });

  it('scan classifies a live pid with mismatching cmdline as stale, not alive', () => {
    const dir = cleanStateDir();
    // pid hiện tại đang sống thật nhưng argv trong metadata là binary khác
    // (wrangler-like) — /proc/cmdline (node) không khớp basename đó → takeover.
    writeFileSync(
      metadataPathOf(dir, 'takeover'),
      JSON.stringify({
        version: 1,
        name: 'takeover',
        pid: process.pid,
        argv: ['/opt/cloudflare/wrangler', 'dev'],
        identityHash: identityHashOf(['/opt/cloudflare/wrangler', 'dev']),
        startedAt: 1,
      }),
      'utf8',
    );
    const entry = scanWorkerProcesses(dir).find((e) => e.name === 'takeover');
    expect(entry?.state).toBe('stale');
  });

  it('startWorkerProcess releases entry lock and cleans pid-0 metadata when spawn throws synchronously', async () => {
    const dir = cleanStateDir();
    let spawned = 0;
    const capture = async (): Promise<Error | null> => {
      try {
        startWorkerProcess({
          name: 'sync-throw',
          argv: [process.execPath, '-e', '1'],
          cwd: dir,
          env: {},
          stateDir: dir,
          spawnImpl: () => {
            spawned += 1;
            throw new Error('sync spawn failure');
          },
        });
      } catch (error) {
        return error as Error;
      }
      return null;
    };
    const err = await capture();
    expect(err?.message).toBe('sync spawn failure');
    expect(spawned).toBe(1);
    // Entry lock phải được giải phóng — spawn lại cùng name không bị chặn bởi lock.
    expect(existsSync(`${metadataPathOf(dir, 'sync-throw')}.lock`)).toBe(false);
    // Metadata pid-0 vừa ghi phải được dọn sạch.
    expect(existsSync(metadataPathOf(dir, 'sync-throw'))).toBe(false);
    // Và spawn tiếp theo cùng name phải chạy bình thường.
    const second = startWorkerProcess({
      name: 'sync-throw',
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    await second.onExit;
    second.removeMetadata();
  });

  it('startWorkerProcess rejects empty argv', () => {
    const dir = cleanStateDir();
    expect(() =>
      startWorkerProcess({ name: 'empty-argv', argv: [], cwd: dir, env: {}, stateDir: dir }),
    ).toThrow('non-empty');
    expect(() =>
      startWorkerProcess({ name: 'empty-exe', argv: [''], cwd: dir, env: {}, stateDir: dir }),
    ).toThrow('non-empty');
  });

  it('readMetadata rejects identityHash mismatch', () => {
    const dir = cleanStateDir();
    const args = [process.execPath, 'main.js'];
    writeFileSync(
      metadataPathOf(dir, 'badhash'),
      JSON.stringify({
        version: 1,
        name: 'badhash',
        pid: 123,
        argv: args,
        identityHash: 'aaaaaaaaaaaaaaaa',
        startedAt: 42,
      }),
      'utf8',
    );
    expect(readMetadata(metadataPathOf(dir, 'badhash'))).toBeNull();
  });

  describe('killWorkerProcessByMetadata', () => {
    it('returns not-provable for invalid metadata, identity mismatch, or dead pid without touching anything', async () => {
      const dir = cleanStateDir();
      const args = [process.execPath, 'worker.js'];
      // Metadata missing entirely.
      expect(
        (
          await killWorkerProcessByMetadata({
            metadataPath: metadataPathOf(dir, 'missing'),
            expectedArgv: args,
          })
        ).result,
      ).toBe('not-provable');
      // Corrupt metadata.
      writeFileSync(metadataPathOf(dir, 'corrupt'), '{bad', 'utf8');
      expect(
        (
          await killWorkerProcessByMetadata({
            metadataPath: metadataPathOf(dir, 'corrupt'),
            expectedArgv: args,
          })
        ).result,
      ).toBe('not-provable');
      // Live pid whose argv record does not match expectedArgv.
      writeFileSync(
        metadataPathOf(dir, 'mismatch'),
        JSON.stringify({
          version: 1,
          name: 'mismatch',
          pid: process.pid,
          argv: [process.execPath, 'other.js'],
          identityHash: identityHashOf([process.execPath, 'other.js']),
          startedAt: 1,
        }),
        'utf8',
      );
      const mismatch = await killWorkerProcessByMetadata({
        metadataPath: metadataPathOf(dir, 'mismatch'),
        expectedArgv: args,
      });
      expect(mismatch).toMatchObject({ result: 'not-provable' });
      // Dead pid (process has nothing to kill).
      writeFileSync(
        metadataPathOf(dir, 'deadpid'),
        JSON.stringify({
          version: 1,
          name: 'deadpid',
          pid: 2147483647,
          argv: args,
          identityHash: identityHashOf(args),
          startedAt: 1,
        }),
        'utf8',
      );
      const dead = await killWorkerProcessByMetadata({
        metadataPath: metadataPathOf(dir, 'deadpid'),
        expectedArgv: args,
      });
      expect(dead).toMatchObject({ result: 'not-provable' });
    });

    it('terminates a live long-running child spawned through the real spawn path', async () => {
      const dir = cleanStateDir();
      const args = [
        process.execPath,
        '-e',
        'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1 << 28);',
      ];
      const handle = startWorkerProcess({
        name: 'killby-meta',
        argv: args,
        cwd: dir,
        env: {},
        stateDir: dir,
      });
      const deadline = Date.now() + 5000;
      while (handle.pid < 0 && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      expect(handle.pid).toBeGreaterThan(0);
      expect(isPidAlive(handle.pid)).toBe(true);

      const outcome = await killWorkerProcessByMetadata({
        metadataPath: handle.metadataPath,
        expectedArgv: args,
        timeoutMs: 3000,
      });
      expect(outcome).toEqual({ result: 'done' });
      const gone = await waitForCondition(() => !isPidAlive(handle.pid), 3000);
      expect(gone).toBe(true);
      handle.removeMetadata();
    });
  });

  it('pidCmdlineMatches allows unreadable/absent pid (cross-platform)', () => {
    expect(pidCmdlineMatches(-1, [process.execPath])).toBe(true);
    expect(pidCmdlineMatches(999999999, [process.execPath])).toBe(true);
  });

  it.skipIf(process.platform !== 'linux')(
    'pidCmdlineMatches on linux matches basename and rejects takeover',
    async () => {
      const dir = cleanStateDir();
      const handle = startWorkerProcess({
        name: 'proc-check-linux',
        argv: [process.execPath, '-e', 'setInterval(() => {}, 1 << 28)'],
        cwd: dir,
        env: {},
        stateDir: dir,
      });
      const deadline = Date.now() + 5000;
      while (handle.pid < 0 && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      expect(handle.pid).toBeGreaterThan(0);
      expect(pidCmdlineMatches(handle.pid, [process.execPath, 'anything.js'])).toBe(true);
      expect(pidCmdlineMatches(handle.pid, ['/nonexistent-totally-different-binary-xyz'])).toBe(
        false,
      );
      await handle.stop(1000);
      handle.removeMetadata();
    },
  );

  it('handle exposes stdout/stderr Readable streams after spawn', async () => {
    const dir = cleanStateDir();
    const handle = startWorkerProcess({
      name: 'stream-check',
      argv: [process.execPath, '-e', 'process.stdout.write("hello"); process.exit(0)'],
      cwd: dir,
      env: {},
      stateDir: dir,
    });
    const deadline = Date.now() + 5000;
    while (handle.pid < 0 && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    expect(handle.stdout).toBeDefined();
    expect(handle.stderr).toBeDefined();
    await handle.onExit;
    expect(handle.exited).toBe(true);
    handle.removeMetadata();
  });
});
