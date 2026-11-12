/**
 * `globalSetup` của Vitest cho suite argv-hygiene của `staff-access-deploy` — probe
 * Docker **một lần** mỗi lần chạy, trước khi bất kỳ worker/spec nào khởi động.
 *
 * Docker là phụ thuộc CỨNG của suite này (nó chạy script provision/migrate thật
 * qua `docker exec`/`docker run`): vắng Docker phải làm TOÀN BỘ lần chạy ĐỎ —
 * skip với exit 0 che mất việc một gate bắt buộc chưa hề chạy
 * (06-testing.md §6). Probe kiểm tra daemon thật (`docker info`) thay vì chỉ
 * existence của binary; image PostgreSQL của suite được `docker run` lúc setup
 * — pull tự diễn ra nếu thiếu, và lỗi pull là lỗi thật của lần chạy.
 */
import { spawnSync } from 'node:child_process';

export default async function setup(): Promise<void> {
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (probe.error !== undefined || probe.status !== 0) {
    throw new Error(
      'Docker is unavailable: the argv-hygiene suite runs the REAL provision/migrate scripts ' +
        'through docker exec/docker run and refuses to skip when the daemon is missing ' +
        '(docs/architecture/06-testing.md §6 — a skipped mandatory gate is not a pass). ' +
        `docker info exited with ${probe.status ?? 'spawn error'}: ${probe.stderr ?? String(probe.error)}`,
    );
  }
}
