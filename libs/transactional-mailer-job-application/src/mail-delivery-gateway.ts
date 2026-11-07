/**
 * Gateway port sang private delivery interface của `transactional-mail` — seam duy nhất mà
 * orchestration (Queue execution, report sweep) dùng để đọc runtime material và báo outcome.
 *
 * Port do **lead** định nghĩa trước khi dispatch để hai nhóm dùng chung một hình dạng; adapter
 * thật bọc `InternalDeliveryClient` (ký HMAC) và nằm ở infrastructure lib
 * (`libs/transactional-mailer-job-infrastructure/src/internal-delivery-gateway.ts`). Orchestration
 * **không** import client trực tiếp — dependency direction: application không biết transport.
 *
 * Phân loại lỗi tuân theo `docs/applications/transactional-mailer-job/02-requirements.md` FR-004
 * và `01-architecture.md` §9.2.2: `401`/`403` là lỗi internal-auth/authz của **chính worker**,
 * không bao giờ được đổi thành provider credential error; `404` là delivery không tồn tại;
 * `400` là contract violation; mọi lỗi network/timeout/`429`/`5xx` là transient.
 */

/** Runtime material của một delivery, đã qua `validateGetDeliveryResponse` của contract. */
export type DeliveryMaterial = {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly app: string;
  readonly status: string;
  readonly recipient: string;
  readonly subject: string;
  readonly body: string;
  readonly contentType: string;
  readonly dispatchGeneration: number;
};

/** Kết quả `GET /internal/deliveries/:delivery_id` sau khi đã phân loại theo status code. */
export type DeliveryLookupResult =
  | { readonly kind: 'found'; readonly delivery: DeliveryMaterial }
  /** Delivery không tồn tại ở control plane (HTTP 404). */
  | { readonly kind: 'not-found' }
  /** `401`/`403` — credential nội bộ hoặc permission sai; không bao giờ là lỗi provider. */
  | { readonly kind: 'auth-rejected' }
  /** Request/response không khớp wire contract (HTTP 400, hoặc body không validate được). */
  | { readonly kind: 'contract-rejected' }
  /** Network error, timeout, `429`, `5xx` — đáng thử lại sau. */
  | { readonly kind: 'transient' };

/** Request body của `POST .../outcome` — shape contract (`PostDeliveryOutcomeRequest`). */
export type OutcomeReportRequest = {
  readonly outcome: 'sent' | 'failed' | 'blocked';
  readonly errorClass?: 'retryable' | 'permanent' | 'credential' | 'contract' | 'internal-auth';
  readonly dispatchGeneration: number;
};

/**
 * Kết quả `POST .../outcome` sau khi đã phân loại — body quyết định kết quả, **không** phải
 * HTTP 200 (`docs/applications/transactional-mail/01-architecture.md` §6.2.2).
 */
export type OutcomeReportResult =
  | { readonly kind: 'applied'; readonly status: string }
  | { readonly kind: 'duplicate'; readonly status: string }
  | { readonly kind: 'stale'; readonly status: string; readonly currentDispatchGeneration: number }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'auth-rejected' }
  | { readonly kind: 'contract-rejected' }
  | { readonly kind: 'transient' };

export interface MailDeliveryGateway {
  /** Đọc runtime material — trả nguyên lần classify; không retry trong port. */
  getDelivery(deliveryId: string): Promise<DeliveryLookupResult>;

  /** Báo outcome — trả nguyên lần classify; không retry trong port. */
  reportOutcome(deliveryId: string, report: OutcomeReportRequest): Promise<OutcomeReportResult>;
}
