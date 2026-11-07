/**
 * Env và cách gọi route cho test của composition root — dùng chung bởi mọi `tests/*.spec.ts`
 * gọi `worker.fetch` thật.
 *
 * ⚠️ **Vì sao file này tồn tại thay vì copy `completeEnv` vào từng spec.** Sáu tham số SLA ở đây
 * là **giá trị test** do harness chọn, và chúng phải **thỏa** `assertConfigCoherence` để
 * `pushConfig` không throw — không phải giá trị SLA đã chốt (`03-operations.md` §11: sáu tham
 * số đó vẫn là launch gate, chưa có giá trị production nào). `pushConfig` fail-closed khi thiếu
 * bất kỳ biến bắt buộc nào, nên một env thiếu sẽ ra `503` chứ không ra `401` — và `503` trong
 * một test auth là dấu hiệu fixture sai, không phải hành vi cần kiểm. Một bản copy thứ hai
 * trong spec khác là một cơ hội để hai test lệch nhau mà không ai thấy.
 *
 * ⚠️ **`push: db.probe.database`, KHÔNG `db.db`.** Nếu env mang database không bọc probe thì
 * probe **không** đếm gì và luôn trả `0` — mọi test "không chạm D1" đều xanh dù route có
 * chạm. `tests/auth-boundary.spec.ts` có hai test hàng rào chứng minh probe nhìn thấy một lần
 * chạm D1 thật; chúng chỉ có ý nghĩa vì dòng này.
 *
 * ⚠️ **Base64 của 32 byte cố định là material test, không phải credential.** Nó nằm trong
 * repo; một khoá production phải nằm trong Worker Secret. Nó tồn tại vì `buildCipher`
 * fail-closed khi thiếu key của version đang phục vụ (`K1`), nên không thể dựng context mà
 * thiếu nó.
 *
 * ⚠️ **Giá trị đó nằm ở `credential-root-key.ts`, không viết lại ở đây.** Fixture seed
 * credential (`d1-harness.ts`) phải mã hoá bằng **cùng** root key mà Worker này đọc — nếu hai
 * bên lệch nhau thì credential seed không giải mã được và cổng chặn enable
 * (`credential_decryption_failed`) làm đỏ test.
 */

import type { PushWorkerEnv } from '../../src/config';
import type { TestDatabase } from './d1-harness';

import worker from '../../src/main';

import { ROOT_KEY_K1_BASE64 } from './credential-root-key';

/** Bearer token của Application API — principal `ecoma-io` là `App` mà nó đại diện. */
export const APPLICATION_TOKEN = 'application-token';

/** Env đầy đủ cho một request đã xác thực. Sửa `...` khi một test cần đổi một biến. */
export function completeEnv(db: TestDatabase): Record<string, unknown> {
  return {
    IDEMPOTENCY_RETENTION_MS: '7000007',
    CALLER_RETRY_WINDOW_MS: '3000003',
    MAX_NOTIFICATION_TTL_MS: '5000005',
    PAYLOAD_DIGEST_ALGORITHM: 'none',
    OUTBOX_RECOVERY_SLA_MS: '1111111',
    DELIVERY_RECONCILIATION_AGE_MS: '2222222',
    RUNTIME_API_EXPECTED_PRINCIPAL: 'svc.web-push-notification-job',
    RUNTIME_API_SHARED_SECRET: 'runtime-secret',
    ADMIN_API_TOKEN: 'admin-token',
    ADMIN_API_PRINCIPAL: 'backoffice',
    APPLICATION_API_TOKEN: APPLICATION_TOKEN,
    APPLICATION_API_PRINCIPAL: 'ecoma-io',
    CREDENTIAL_KEY_VERSION: 'K1',
    CREDENTIAL_SERVING_VERSIONS: 'K1',
    PUSH_CREDENTIAL_ROOT_KEY_K1: ROOT_KEY_K1_BASE64,
    ENVIRONMENT: 'test',
    LOG_LEVEL: 'error',
    push: db.probe.database,
    // ⚠️ Queue thật không có trong các test route: không route nào ở đây publish, và một
    // binding giả ghi lại lời gọi sẽ khiến một test "không chạm D1" có một đường ghi khác.
    QUEUE: { send: async (): Promise<void> => undefined },
  };
}

/**
 * Kiểu context của `fetch` — lấy từ chính handler thay vì global `ExecutionContext`.
 *
 * ⚠️ `ExecutionContext` là global của `@cloudflare/workers-types`, mà `tsconfig.spec.json` của
 * app này khai `types: ["node", "vitest", ...]` — không có workers-types — nên tham chiếu
 * global đó là một `TS2304`. Suy ra kiểu từ `Parameters<typeof worker.fetch>` giữ đúng cái mà
 * `main.ts` khai, và **tự đỏ** nếu signature của Worker đổi.
 */
export type WorkerExecutionContext = NonNullable<Parameters<typeof worker.fetch>[2]>;

/** Header của một caller Application API đã xác thực. */
export function applicationHeaders(): Record<string, string> {
  return { authorization: `Bearer ${APPLICATION_TOKEN}`, 'content-type': 'application/json' };
}

/**
 * Gọi `worker.fetch` với env của `TestDatabase` đã đếm lệnh.
 *
 * ⚠️ **`method` mặc định là `GET`, và Hono trả `404` chứ không phải `405` cho method sai.**
 * Một `POST`-only route bị gọi bằng `GET` rơi vào `notFound` — cùng status với "route không
 * tồn tại". Trong một test boundary điều đó là cái bẫy tệ nhất: `404` **khác** `401`, nhưng
 * nếu test chỉ khẳng định "không phải `2xx`" thì nó xanh dù route đã biến mất. Bản đầu của
 * `auth-boundary.spec.ts` đã mắc đúng bẫy này (`callRoute(db, '/internal/…/claim', {})` mà
 * không truyền method → `404` ở cả 11 test của `describe` đó). Vì vậy:
 *   - mọi route không phải `GET` **phải** truyền `method` tường minh, và
 *   - `callRuntimeClaim` dưới đây tồn tại để route claim không còn chỗ cho suy đoán.
 */
export async function callRoute(
  db: TestDatabase,
  path: string,
  headers: Record<string, string>,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<Response> {
  const requestInit: RequestInit = { method: init.method ?? 'GET', headers };
  if (init.body !== undefined) {
    requestInit.body = JSON.stringify(init.body);
    requestInit.headers = { 'content-type': 'application/json', ...headers };
  }
  return worker.fetch(
    new Request(`https://push-notification.test${path}`, requestInit),
    completeEnv(db) as unknown as PushWorkerEnv,
    // `ctx` không dùng bởi bất kỳ route nào ở đây; truyền một object rỗng là đủ.
    {} as WorkerExecutionContext,
  );
}

/** `worker.fetch` trực tiếp — cho test cần `method`/`headers` không đi qua `callRoute`. */
export async function callRaw(
  db: TestDatabase,
  path: string,
  method: string,
  headers: Record<string, string>,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://push-notification.test${path}`, { method, headers }),
    completeEnv(db) as unknown as PushWorkerEnv,
    {} as WorkerExecutionContext,
  );
}

/**
 * Gọi `POST /internal/deliveries/:id/claim` — route runtime **chỉ** có `POST` (§8.1).
 *
 * ⚠️ Hàm này tồn tại vì một lý do rất cụ thể. `callRoute` mặc định `GET`, và `GET` trên một
 * route chỉ có `POST` trả **404 `not_found`** chứ không phải `405`. Một test auth viết
 * `callRoute(db, path, headers)` mà không truyền `method` vì vậy đo **route không tồn tại**,
 * không phải boundary — và nó xanh sai: `404` khác `401`, nhưng nếu test chỉ khẳng định
 * "không phải `2xx`" thì bao giờ cũng xanh. Route claim phải có `POST` tường minh ở mọi
 * call site để một route đổi method không lặng lẽ làm một bộ test auth hỏng theo hướng
 * dễ hiểu nhầm nhất.
 */
export function callRuntimeClaim(
  db: TestDatabase,
  deliveryId: string,
  headers: Record<string, string>,
): Promise<Response> {
  return callRoute(db, `/internal/deliveries/${deliveryId}/claim`, headers, { method: 'POST' });
}
