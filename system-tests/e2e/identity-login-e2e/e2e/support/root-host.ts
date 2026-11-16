import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Đọc giá trị `host:port` gốc của stack từ `ROOT_HOST` — module lá, KHÔNG
 * import support nào khác. Tách khỏi `local-origin.ts` để không tạo vòng
 * import `local-origin` ↔ `local-stack` (local-origin cần
 * `resolveStackNamespace` của local-stack; local-stack cần hàm này).
 *
 * ENV trước, fallback parse `.env` repo root TẠI THỜI ĐIỂM ĐỌC. Fallback không
 * phải chỉ cho CLI ngoài Nx: orchestrator của Nx snapshot env của MỌI task đã
 * schedule ngay vòng lặp đầu, TRƯỚC khi `platform-deploy:local-up` kịp ghi
 * `.env` — env-process của task suite không bao giờ chứa `ROOT_HOST` trong
 * đường một-invocation (`nx affected -t system-test -c local`) dù `.env` mới
 * nhất đã có key đó. Đọc FILE lúc helper chạy thì luôn thấy giá trị platform
 * vừa ghi. ENV đã có (export tay, hoặc chạy lại suite sau khi invocation đầu
 * đã deploy) thì thắng fallback — nguồn ưu tiên như trước.
 */
const SUITE_DIR = dirname(fileURLToPath(import.meta.url));

export function readRootHostPort(): string {
  const fromEnv = process.env.ROOT_HOST;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  try {
    const text = readFileSync(join(SUITE_DIR, '../../../../../.env'), 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      const match = /^ROOT_(?:DOMAIN|HOST)=(.*)$/u.exec(line.trim());
      if (match && match[1].trim().length > 0) {
        return match[1].trim();
      }
    }
  } catch {
    // `.env` vắng mặt — throw bên dưới với message chỉ đúng remedy.
  }
  throw new Error(
    'ROOT_HOST is neither set in the environment nor defined in the repo-root .env. ' +
      'Run this suite through `nx affected -t system-test -c local` (Nx provisions the local-up prerequisites, ' +
      'and platform-deploy writes the dynamic Traefik host:port into the repo-root .env before the suite runs), ' +
      'or export ROOT_HOST=<host>:<port> explicitly.',
  );
}
