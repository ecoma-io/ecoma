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

/** Tên network platform của stack mà `origin` đang chạy. */
export async function resolvePlatformNetwork(origin: string): Promise<string> {
  const port = new URL(origin).port;
  // `traefikNamespaceOrNull` tự chạy `docker ps` với timeout 10s — vừa chứng tỏ
  // daemon sống, vừa resolve namespace; mọi lỗi đều đi qua `failureDetail`
  // có cấu trúc thay vì lỗi docker thô.
  const { namespace, failureDetail } = traefikNamespaceOrNull(port);
  if (namespace !== undefined) {
    return `ecoma-${namespace}-network`;
  }
  throw new Error(
    `no traefik container publishes host port ${port} (${failureDetail}) — the local stack is not running`,
  );
}
