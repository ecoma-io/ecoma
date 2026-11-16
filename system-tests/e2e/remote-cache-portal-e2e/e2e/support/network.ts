import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { traefikNamespaceOrNull } from './stack-env';

/**
 * Resolve network platform của stack local từ port Traefik publish.
 *
 * Phép map namespace thuộc về `stack-env.ts` (`traefikNamespaceOrNull` — một
 * bản duy nhất trong suite); file này chỉ bọc tên network cho các spec chạy
 * `docker run --network=…` (portal-journey: curl, nx-cli-journey: container
 * Nx). Namespace `undefined` là lỗi cài đặt stack — ném với `failureDetail`
 * thay vì đoán.
 */

const execFileAsync = promisify(execFile);

/** Tên network platform của stack mà `origin` đang chạy. */
export async function resolvePlatformNetwork(origin: string): Promise<string> {
  const port = new URL(origin).port;
  // Timeout đề phòng daemon treo giữ worker Playwright vô hạn (phép dò dùng
  // `docker ps` phía trong `traefikNamespaceOrNull` đã có timeout riêng).
  await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeout: 10_000,
  });
  const { namespace, failureDetail } = traefikNamespaceOrNull(port);
  if (namespace !== undefined) {
    return `ecoma-${namespace}-network`;
  }
  throw new Error(
    `no traefik container publishes host port ${port} (${failureDetail}) — the local stack is not running`,
  );
}
