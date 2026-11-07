/**
 * Bề mặt binding của Worker `web-push-notification-job`, khai **hẹp** — không phải global
 * `D1Database`/`Queue`/`Fetcher` của `@cloudflare/workers-types`.
 *
 * ⚠️ **Vì sao khai bề mặt hẹp.** Đây là đúng hợp đồng adapter cần: adapter chỉ dùng `prepare`
 * của D1 và `send` của Queue, nên khai toàn bộ binding là một dependency thừa. Lợi ích thứ
 * hai mới là lợi ích thật: thiếu một binding trở thành lỗi **compile** ở composition root thay
 * vì lỗi runtime ở message đầu tiên. Binding thật của Workers thỏa các interface này theo
 * hình thức, nên khai bằng chúng không mất gì khi deploy.
 *
 * ⚠️ **Không** đặt `RUNTIME_API_SHARED_SECRET` / `RUNTIME_API_EXPECTED_PRINCIPAL` vào một
 * interface bắt buộc ở đây. Cấu hình thiếu phải là một **lỗi runtime có metric**
 * (`runtime_resolution_errors` + bounded retry → DLQ), không phải một lỗi compose-time không
 * ai thấy — xem `resolveRuntimeSharedSecret` trong
 * `@ecoma-io/web-push-notification-job-infrastructure/src/runtime-control-plane.ts`.
 */

import type {
  D1DatabaseLike,
  RuntimeServiceBinding,
} from '@ecoma-io/web-push-notification-job-infrastructure';

/** Binding mà job state cần: D1 `push-job` (binding `push-job`). */
export type JobStateEnv = {
  /** D1 `push-job` — job execution state của chính worker (FR-022). */
  readonly 'push-job': D1DatabaseLike;
};

/**
 * Request của endpoint reconciliation — phần `fetch` mà boundary auth cần.
 *
 * ⚠️ Thu hẹp về `headers` + `method` + `url`: `authenticateReconciliationCaller` chỉ đọc
 * header, và route match đọc `url`. Không nhận `Request` đầy đủ ở tầng application để một
 * test không cần dựng `Request` của Workers runtime mới kiểm được boundary.
 */
export interface ReconcileRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
}

export type { RuntimeServiceBinding };
