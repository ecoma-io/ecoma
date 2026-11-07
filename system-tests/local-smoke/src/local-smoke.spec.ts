import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Suite này kiểm smoke script bằng tiến trình thật: fixture HTTPS trên
 * 127.0.0.1:0 dựng bằng certificate local của repo (`fbi.com`), script chạy với
 * hostname `fbi.com` và cờ `--connect 127.0.0.1:<port>` — TLS hostname check
 * vẫn chạy thật vì SNI/`servername` là `fbi.com`, khớp certificate. Exit code
 * và stderr là contract công khai của script (entry `local.ts smoke` của
 * platform gọi nó qua `node` và đọc exit code), nên mỗi case spawn tiến trình riêng.
 *
 * Retry policy được chứng minh bằng đồng vị: 502 rồi thành công → exit 0
 * (retry-then-success), 500 thì fail tức thời (không RETRY trong stderr),
 * always-502 với budget nhỏ → exit 1 (budget exhaustion). Lỗi TLS và hostname
 * mismatch phải exit 1 tức thời — script không bao giờ nuốt lỗi xác minh.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Root của workspace, suy từ vị trí file này (`system-tests/local-smoke/src`).
const ROOT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../../..');

const script = join(ROOT_DIR, 'system-tests/local-smoke/src/local-smoke.mjs');
const certPath = join(ROOT_DIR, 'deploys/platform-deploy/local-certs/fbi.com.crt');
const keyPath = join(ROOT_DIR, 'deploys/platform-deploy/local-certs/fbi.com.key');

const HOME_TITLE = '<title>Ecoma.io — public home</title>';

const fixtures: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  const open = fixtures.splice(0);
  await Promise.all(open.map((fixture) => fixture.close()));
});

async function closeServer(server: {
  close(): void;
  closeAllConnections?(): void;
  readonly listening: boolean;
}): Promise<void> {
  // closeAllConnections hủy socket còn mở (fixture "không bao giờ trả lời"
  // giữ socket treo) — không destroy thì `close` đợi cho tới khi socket chết.
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => {
    server.close();
    // Đợi listener thật sự đóng thay vì tin callback: kiểu của `close` trong
    // tsconfig này không nhận callback, nên poll listening cho chắc.
    const startedAt = Date.now();
    const poll = () => {
      if (!server.listening || Date.now() - startedAt > 5000) resolve();
      else setTimeout(poll, 10);
    };
    poll();
  });
}

type HttpHandler = (pathname: string, req: IncomingMessage, res: ServerResponse) => void;

/** Handler chuẩn đúng hành vi home thật: `/` 302 → `/en`, `/en` 200 HTML. */
function homeHandler(pathname: string, _req: IncomingMessage, res: ServerResponse): void {
  if (pathname === '/') {
    res.writeHead(302, { location: '/en' });
    res.end();
    return;
  }
  if (pathname === '/en') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head>${HOME_TITLE}</head><body></body></html>`);
    return;
  }
  res.writeHead(404);
  res.end();
}

/**
 * HTTPS fixture với certificate local, nghe 127.0.0.1:0 — trả về port thật.
 * `handler` nhận path đã tách khỏi request; trả lời bằng res như http thường.
 */
async function startHttpsFixture(handler: HttpHandler): Promise<number> {
  const server = https.createServer(
    { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') },
    (req, res) => {
      req.resume(); // tiêu thụ request body để socket không kẹt
      handler(req.url ?? '/', req, res);
    },
  );
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  fixtures.push({ close: () => closeServer(server) });
  return port;
}

/**
 * TCP fixture thô — điều khiển socket thô từng connection (viết gì tuỳ ý, hoặc
 * không bao giờ trả lời). Dùng cho kịch bản "đối tác không nói TLS" và
 * "upstream treo": script phải fail, không được nuốt. `close()` destroy socket
 * client đang mở — `close()` thường đợi socket chết mới xong, socket treo thì
 * không bao giờ.
 */
async function startRawFixture(tap: (socket: net.Socket) => void): Promise<number> {
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    tap(socket);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  fixtures.push({
    close: async () => {
      for (const socket of clients) socket.destroy();
      await closeServer(server);
    },
  });
  return port;
}

/**
 * Chạy smoke script trong tiến trình riêng, thu exit code + stdout/stderr.
 *
 * Dùng `spawn` BẤT ĐỒNG BỘ (wrap Promise) chứ không `execFileSync`: script cần
 * mở kết nối TCP ngược về fixture HTTPS trong chính process test này, mà môi
 * trường runner ở đây không phân phối dữ liệu cho connection của tiến trình
 * spawn ĐỒNG BỘ (spawnSync/execFileSync chặn event loop của parent khi parent
 * đang giữ listening socket — client chỉ TCP-handshake được rồi treo). Async
 * spawn giữ event loop của parent sống và đường data đi bình thường.
 */
function run(
  args: string[],
  timeoutMs = 30000,
): Promise<{ status: number; stdout: string; stderr: string; ms: number }> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(killer);
      resolve({
        status: code ?? -1,
        stdout,
        stderr: stderr.trim(),
        ms: Date.now() - startedAt,
      });
    });
  });
}

/** Sinh argv fixture chuẩn: hostname fbi.com + --connect về loopback port. */
function fixtureArgs(port: number, extra: string[] = []): string[] {
  return [`fbi.com:${port}`, '--connect', `127.0.0.1:${port}`, ...extra];
}

// Budget/timeout nhỏ cho fixture: mọi case fail phải xong trong vài trăm ms,
// riêng case retry-then-success ~3s (backoff 1s + 2s) — suite vẫn gọn.
const FAST: string[] = ['--budget-ms', '1500', '--request-timeout-ms', '1000'];

describe('local-smoke.mjs input contract', () => {
  it('no argument → usage, exit 2', async () => {
    const result = await run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage');
  });

  it('rootHost without port → exit 2 with format error', async () => {
    const result = await run(['fbi.com']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('<hostname>:<port>');
  });

  it('port not a number → exit 2', async () => {
    const result = await run(['fbi.com:notaport']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid port');
  });

  it('port out of range → exit 2', async () => {
    const result = await run(['fbi.com:99999']);
    expect(result.status).toBe(2);
  });

  it('unknown flag → exit 2', async () => {
    const result = await run(['fbi.com:1', '--wat']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--wat');
  });

  it('flag value not a positive integer → exit 2', async () => {
    const result = await run(['fbi.com:1', '--budget-ms', 'abc']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--budget-ms');
  });

  it('unreachable host:port → exit 1 after budget (refused is retried, not swallowed)', async () => {
    // Port 1 trên loopback: connection refused — chữ ký "chưa sẵn sàng" được
    // retry, nên budget nhỏ buộc script chốt FAIL thay vì treo 90s. Bằng chứng
    // script KHÔNG fake pass khi server không có.
    const result = await run(['fbi.com:1', ...FAST]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke FAILED');
    expect(result.stderr).toContain('ECONNREFUSED');
    // Hết budget là một đường fail — stdout KHÔNG BAO GIỜ được khen "smoke OK"
    // song song với "smoke FAILED" ở stderr (log mâu thuẫn làm chẩn đoán sai).
    expect(result.stdout).not.toContain('smoke OK');
  });
});

describe('local-smoke.mjs HTTPS verification chain', () => {
  it('happy path: 302 → /en → 200 with title marker → exit 0', async () => {
    const port = await startHttpsFixture(homeHandler);
    const result = await run(fixtureArgs(port, FAST));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('smoke OK');
    expect(result.stdout).toContain('302 → 200');
    expect(result.stdout).toContain('TLS valid with the local certificate');
    // stdout và stderr là hai hợp đồng riêng: thành công thì stdout khen,
    // stderr không có dòng FAILED/RETRY nào.
    expect(result.stderr).not.toContain('smoke FAILED');
    expect(result.stderr).not.toContain('smoke RETRY');
  });

  it('wrong redirect location /fr → exit 1 immediately', async () => {
    const port = await startHttpsFixture((pathname, req, res) => {
      if (pathname === '/') {
        res.writeHead(302, { location: '/fr' });
        res.end();
        return;
      }
      homeHandler(pathname, req, res);
    });
    const result = await run(fixtureArgs(port, FAST));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected location '/en'");
    expect(result.stderr).not.toContain('smoke RETRY');
  });

  it('root returns 200 instead of 302 → exit 1', async () => {
    const port = await startHttpsFixture((pathname, req, res) => {
      if (pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html></html>');
        return;
      }
      homeHandler(pathname, req, res);
    });
    const result = await run(fixtureArgs(port, FAST));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected status 302, got 200');
  });

  it('root returns 404 → retried, then exit 1 at budget exhaustion', async () => {
    // 404 là retryable (cửa sổ Traefik registration khi container recreate) —
    // không fail tức thời nữa: budget nhỏ buộc hết budget rồi chốt FAIL.
    const port = await startHttpsFixture((_pathname, _req, res) => {
      res.writeHead(404);
      res.end();
    });
    const result = await run(fixtureArgs(port, FAST));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('budget exhausted');
  });

  it('/en returns 404 → retried, then exit 1 at budget exhaustion', async () => {
    const port = await startHttpsFixture((pathname, req, res) => {
      if (pathname === '/en') {
        res.writeHead(404);
        res.end();
        return;
      }
      homeHandler(pathname, req, res);
    });
    const result = await run(fixtureArgs(port, FAST));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('budget exhausted');
  });

  it('/en returns 500 → exit 1 fast without retry (SSR error is not "not ready")', async () => {
    const port = await startHttpsFixture((pathname, req, res) => {
      if (pathname === '/en') {
        res.writeHead(500);
        res.end();
        return;
      }
      homeHandler(pathname, req, res);
    });
    const result = await run(fixtureArgs(port, FAST));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected 2xx, got 500');
    // 500 phải fail tức thời: không một dòng RETRY nào, không đợi budget.
    expect(result.stderr).not.toContain('smoke RETRY');
    expect(result.ms).toBeLessThan(3000);
  });

  it('/en returns 502 twice then 200 → exit 0 (retry-then-success over cold start)', async () => {
    let enRequests = 0;
    const port = await startHttpsFixture((pathname, req, res) => {
      if (pathname === '/en' && enRequests < 2) {
        enRequests += 1;
        res.writeHead(502);
        res.end();
        return;
      }
      homeHandler(pathname, req, res);
    });
    // Budget phải đủ cho hai lần backoff (1s + 2s) cộng attempt thứ ba.
    const result = await run(fixtureArgs(port, ['--budget-ms', '10000']), 20000);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('smoke OK');
    expect(enRequests).toBe(2);
  });

  it('always 502 with tiny budget → exit 1 (budget exhaustion fails loudly)', async () => {
    const port = await startHttpsFixture((pathname, req, res) => {
      if (pathname === '/en') {
        res.writeHead(502);
        res.end();
        return;
      }
      homeHandler(pathname, req, res);
    });
    const result = await run(fixtureArgs(port, ['--budget-ms', '500']));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke FAILED');
    expect(result.stderr).toContain('budget exhausted 500ms');
    expect(result.stderr).toContain('status 502');
  });

  it('server speaking cleartext HTTP where TLS is expected → exit 1', async () => {
    // TLS handshake của script sẽ fail khi đối tác trả lời cleartext — lỗi xác
    // minh phải bật ra, không được retry vô nghĩa cũng không được nuốt.
    const port = await startRawFixture((socket) => {
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n');
    });
    const result = await run(fixtureArgs(port, FAST));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke FAILED');
  });

  it('hostname mismatch against fbi.com certificate → exit 1 (certificate error is not swallowed)', async () => {
    const port = await startHttpsFixture(homeHandler);
    // SNI/hostname check chạy với positional hostname — `wrong.example.com`
    // không khớp SAN `fbi.com` của certificate: lỗi TLS phải bật ra tức thời.
    const result = await run([
      `wrong.example.com:${port}`,
      '--connect',
      `127.0.0.1:${port}`,
      ...FAST,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid TLS/certificate');
    expect(result.stderr).not.toContain('smoke RETRY');
  });

  it('socket that never responds → exit 1 after request timeout retries exhaust budget', async () => {
    // Cố ý KHÔNG trả lời — mô phỏng upstream treo giữa cold start; chữ ký
    // "timeout" được retry, nên case chốt bằng budget exhaustion.
    const port = await startRawFixture(() => {
      // không làm gì cả
    });
    const result = await run(
      fixtureArgs(port, ['--budget-ms', '1500', '--request-timeout-ms', '200']),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke FAILED');
  });

  it('headers sent then socket destroyed mid-body → retried as not-ready, not a crash', async () => {
    // Header 200 đã ghi ra socket rồi destroy — response stream của script
    // phát 'aborted'/'error' giữa chừng body. Lỗi này PHẢI đi qua bộ phân
    // loại (retry) chứ không phải uncaught exception giết tiến trình (exit
    // code sẽ không phải 1 và stack trace Node sẽ lọt ra stderr).
    let connections = 0;
    const port = await startRawFixture((socket) => {
      connections += 1;
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort');
        socket.destroy();
      });
    });
    // Không retry được (fixture luôn hỏng giống nhau) → chốt bằng budget
    // exhaustion: exit 1 với message "smoke FAILED", KHÔNG phải crash Node.
    const result = await run(
      fixtureArgs(port, ['--budget-ms', '1500', '--request-timeout-ms', '200']),
    );
    expect(connections).toBeGreaterThan(0);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke FAILED');
    expect(result.stderr).not.toMatch(/at .*\n.*at /u); // không stack trace Node
  });
});

/**
 * Hợp đồng output: `smoke OK` CHỈ in ngay sau khi verifyChain() thành công.
 * Các case dưới đây kiểm trực tiếp stdout/stderr riêng biệt — exit code một
 * mình không đủ, vì log vừa báo FAILED vừa báo OK là log nói dối đúng lúc người
 * đọc cần tin nhất. 500 → fail tức thời, 502→200 → exit 0, 502 liên tục → exit 1.
 */
describe('local-smoke.mjs smoke OK contract', () => {
  it('successful verification prints smoke OK (stdout), exit 0', async () => {
    const port = await startHttpsFixture(homeHandler);
    const result = await run(fixtureArgs(port, FAST));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('smoke OK');
    expect(result.stdout).toContain('302 → 200');
    // stderr phải trống hoặc chỉ có dòng thành công — không có FAILED/RETRY.
    expect(result.stderr).not.toContain('smoke FAILED');
    expect(result.stderr).not.toContain('smoke RETRY');
  });

  it('non-retryable failure (500) prints failure message, exits nonzero, no smoke OK', async () => {
    const port = await startHttpsFixture((pathname, req, res) => {
      if (pathname === '/en') {
        res.writeHead(500);
        res.end();
        return;
      }
      homeHandler(pathname, req, res);
    });
    const result = await run(fixtureArgs(port, FAST));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke FAILED');
    expect(result.stderr).toContain('expected 2xx, got 500');
    // stdout KHÔNG bao giờ khen khi verify chưa từng thành công.
    expect(result.stdout).not.toContain('smoke OK');
    expect(result.stdout).not.toContain('302 → 200');
    expect(result.ms).toBeLessThan(3000);
  });

  it('retryable failure exhausting budget prints failure message, exits nonzero, no smoke OK', async () => {
    const port = await startHttpsFixture((_pathname, _req, res) => {
      res.writeHead(502);
      res.end();
    });
    const result = await run(fixtureArgs(port, ['--budget-ms', '500']));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('smoke FAILED');
    expect(result.stderr).toContain('budget exhausted 500ms');
    expect(result.stderr).toContain('status 502');
    expect(result.stdout).not.toContain('smoke OK');
  });

  it('retryable failure then successful verification prints smoke OK and exits zero', async () => {
    let enRequests = 0;
    const port = await startHttpsFixture((pathname, req, res) => {
      if (pathname === '/en' && enRequests < 2) {
        enRequests += 1;
        res.writeHead(502);
        res.end();
        return;
      }
      homeHandler(pathname, req, res);
    });
    const result = await run(fixtureArgs(port, ['--budget-ms', '10000']), 20000);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('smoke OK');
    expect(result.stdout).toContain('302 → 200');
    expect(result.stderr).not.toContain('smoke FAILED');
    expect(enRequests).toBe(2);
  });
});
