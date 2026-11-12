/**
 * Spawn `tools/llm-upstream-mock` như một tiến trình con độc lập cho
 * integration test của `llm-api`.
 *
 * Vì sao spawn chứ không import: mock là `type:tooling` + `scope:local` +
 * `runtime:native`, còn `llm-api` là `type:composition` + `runtime:edge` —
 * module boundary cấm mọi cạnh import trực tiếp trên cả ba trục, và bản thân
 * mock cũng không có entry `exports` để resolve. Tiến trình con qua `tsx`
 * không tạo cạnh Nx graph nào (docs/architecture/06-testing.md §5: harness tự
 * sở hữu readiness, không thêm cạnh graph giả); tsx đã là root devDependency
 * và `runBootstrapCli` của harness dùng đúng cơ chế resolve tương tự.
 *
 * Credential mock (khi bật `MOCK_UPSTREAM_EXPECTED_AUTHORIZATION`) chỉ đi qua
 * env của tiến trình con — không argv — và stdout/stderr được thu lại để assert
 * "không bao giờ chứa plaintext" (fence chống lộ ở chính test harness).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireFromHere = createRequire(import.meta.url);

/** Repo root tính từ file này: `apps/llm-api/tests/integrations/` đi lên 4 cấp. */
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** Entry của mock — đường dẫn tuyệt đối nên không phụ thuộc cwd của spec. */
const MOCK_ENTRYPOINT = resolve(REPO_ROOT, 'tools', 'llm-upstream-mock', 'src', 'main.ts');

/** Đúng dòng readiness mà mock in trong listen callback (`main.ts`). */
const LISTENING_PATTERN = /llm-upstream-mock listening on http:\/\/127\.0\.0\.1:(\d+)/u;

/** Một instance mock đang sống — port đã bind, output đã thu, stop được. */
export interface UpstreamMockProcess {
  readonly port: number;
  readonly url: string;
  /** Stdout đã thu tới thời điểm gọi — phục vụ assert metadata-only log. */
  stdout(): string;
  /** Stderr đã thu tới thời điểm gọi. */
  stderr(): string;
  /** SIGTERM → đợi exit → SIGKILL nếu quá 3s; idempotent. */
  stop(): Promise<void>;
}

const liveMocks = new Set<() => Promise<void>>();

/** Stop mọi mock còn sống — gọi trong afterAll của spec (cleanup có bảo vệ). */
export async function stopAllUpstreamMocks(): Promise<void> {
  await Promise.all([...liveMocks].map((stop) => stop()));
}

/** Đợi tiến trình con thoát, tối đa `timeoutMs` — hết hạn vẫn resolve để caller escalate. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      resolveExit();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

/**
 * Khởi động một mock instance với port ephemeral. `env` ghi đè lên env mặc định
 * (`MOCK_UPSTREAM_PORT=0`) — truyền scenario/expected-authorization ở đây.
 * Startup hỏng (exit trước khi listen, không listen sau 15s) là reject — test
 * phải đỏ chứ không rơi vào mock "chưa sẵn sàng" vô hình.
 */
export function startUpstreamMock(env: Record<string, string> = {}): Promise<UpstreamMockProcess> {
  const tsxCli = requireFromHere.resolve('tsx/cli');
  const child = spawn(process.execPath, [tsxCli, MOCK_ENTRYPOINT], {
    cwd: REPO_ROOT,
    env: { ...process.env, MOCK_UPSTREAM_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutText = '';
  let stderrText = '';
  let port = 0;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped || child.exitCode !== null || child.signalCode !== null) {
      liveMocks.delete(stop);
      return;
    }
    stopped = true;
    child.kill('SIGTERM');
    await waitForExit(child, 3_000);
    if (child.exitCode === null && child.signalCode === null) {
      // SIGTERM không chạm được mock (tsx relay lạ thường) — cưỡng chế để
      // không để lại tiến trình sót sau khi test kết thúc.
      child.kill('SIGKILL');
      await waitForExit(child, 3_000);
    }
    liveMocks.delete(stop);
  };

  return new Promise<UpstreamMockProcess>((resolveReady, rejectReady) => {
    const readinessTimer = setTimeout(() => {
      void stop();
      rejectReady(
        new Error(
          `llm-upstream-mock did not report readiness within 15s\nstdout: ${stdoutText}\nstderr: ${stderrText}`,
        ),
      );
    }, 15_000);
    const failOnce = (error: Error): void => {
      clearTimeout(readinessTimer);
      void stop();
      rejectReady(error);
    };
    child.once('error', (error) => {
      failOnce(new Error(`failed to spawn llm-upstream-mock: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      if (port === 0) {
        // Exit trước khi listen: ConfigError của mock in stderr — đưa kèm để
        // diagnostic thấy ngay lỗi cấu hình thay vì một timeout mù.
        failOnce(
          new Error(
            `llm-upstream-mock exited before listening (code=${code} signal=${signal})\nstdout: ${stdoutText}\nstderr: ${stderrText}`,
          ),
        );
      }
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutText += chunk;
      const match = LISTENING_PATTERN.exec(stdoutText);
      if (match !== null && port === 0) {
        port = Number(match[1]);
        clearTimeout(readinessTimer);
        liveMocks.add(stop);
        resolveReady({
          port,
          url: `http://127.0.0.1:${port}`,
          stdout: () => stdoutText,
          stderr: () => stderrText,
          stop,
        });
      }
    });
    // stderr chỉ được thu để diagnostic — không làm tín hiệu hỏng (tsx có thể
    // in cảnh báo vô hại); exit-trước-listen và timeout mới là tín hiệu phân định.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrText += chunk;
    });
  });
}
