import { traefikNamespaceOrNull } from './stack-env';

/**
 * Resolve network platform của stack local từ port Traefik publish — bọc tên
 * network cho các spec chạy `docker run --network=…` (container Nx CLI và
 * client inference). Namespace `undefined` là lỗi cài đặt stack — ném với
 * `failureDetail` thay vì đoán.
 */

/** Tên network platform của stack mà `origin` đang chạy. */
export async function resolvePlatformNetwork(origin: string): Promise<string> {
  const port = new URL(origin).port;
  const { namespace, failureDetail } = traefikNamespaceOrNull(port);
  if (namespace !== undefined) {
    return `ecoma-${namespace}-network`;
  }
  throw new Error(
    `no traefik container publishes host port ${port} (${failureDetail}) — the local stack is not running`,
  );
}
