/**
 * Kiểm tra sẵn sàng của ba Hyperdrive binding của deploy unit `llm-api`.
 *
 * Hợp đồng HTTP đóng băng (Issue #22): `/ready` và `/v1/models` fail-closed —
 * chỉ trả 200 khi cả ba binding kết nối được và `SELECT 1` thành công trên cả
 * ba database; một binding thiếu/kết nối lỗi/timeout đều là 503. Mỗi binding
 * có deadline riêng 3s (giữ đúng semantics Rust `src/readiness.rs`) nên route
 * không bao giờ treo chờ database chết.
 *
 * Bất biến platform: KHÔNG BAO GIỜ log connection string, credential hay body.
 * Log chỉ cấu trúc tối thiểu (route, outcome, tên binding lỗi + nhãn tiếng Anh).
 */
import type { BindingName, LlmApiEnv } from './env';
import {
  BINDING_GATEWAY,
  BINDING_NAMES,
  BINDING_MARKETPLACE,
  BINDING_TENANT,
  readBinding,
} from './env';
import { OperationDeadlineError, withClient, type BindingLimiter } from './connections';

/**
 * Deadline operation per-binding của probe readiness (một trong năm knob,
 * xem `connections.ts`). Deadline bao trùm admission + connect + query — hết
 * deadline là operation bị terminate thật (review P1 của PR #152), không
 * chỉ thời gian trả HTTP response. Đủ ngắn để `/ready` không treo, đủ dài
 * cho connection thật qua Hyperdrive local emulation.
 */
export const READINESS_DEADLINE_MS = 3_000;

/**
 * Trạng thái probe một binding. Giá trị chuỗi chính là nhãn runtime tiếng Anh
 * (chỉ dùng cho log cấu trúc tối thiểu — không bao giờ đi vào body).
 */
export type BindingStatus = 'ready' | 'unavailable' | 'missing' | 'timeout';

/** Nhãn runtime tiếng Anh của từng trạng thái (port của `BindingStatus::label`). */
export const BINDING_STATUS_LABELS: Readonly<Record<BindingStatus, string>> = {
  ready: 'ready',
  unavailable: 'unavailable',
  missing: 'missing',
  timeout: 'timeout',
};

/** Bảng trạng thái của cả ba binding sau một vòng probe. */
export interface ReadinessReport {
  readonly gateway: BindingStatus;
  readonly tenant: BindingStatus;
  readonly marketplace: BindingStatus;
}

/** Trạng thái của một binding theo tên khai báo của `wrangler.jsonc`. */
function statusOf(report: ReadinessReport, binding: BindingName): BindingStatus {
  switch (binding) {
    case BINDING_GATEWAY:
      return report.gateway;
    case BINDING_TENANT:
      return report.tenant;
    case BINDING_MARKETPLACE:
      return report.marketplace;
  }
}

/** Fail-closed: chỉ sẵn sàng khi cả ba binding đều Ready — một binding xuống là
 * toàn bộ data plane coi như chưa sẵn sàng. */
export function isReady(report: ReadinessReport): boolean {
  return BINDING_NAMES.every((binding) => statusOf(report, binding) === 'ready');
}

/**
 * Các binding chưa Ready, theo đúng thứ tự khai báo — dùng cho log. Mỗi phần
 * tử là `[tên binding, trạng thái]`.
 */
export function failures(report: ReadinessReport): Array<[string, BindingStatus]> {
  return BINDING_NAMES.flatMap((binding) => {
    const status = statusOf(report, binding);
    return status === 'ready' ? [] : [[binding, status] as [string, BindingStatus]];
  });
}

/**
 * Probe song song cả ba binding, mỗi probe có deadline operation riêng 3s
 * (admission + connect + query trong cùng một budget). Binding thiếu trong
 * env là `missing` — fail-closed, không bao giờ suy đoán. `limiters` là bộ
 * limiter per-binding tạo một lần trong `buildApp()` — mọi probe đi qua
 * admission control, không có đường tạo client nào ngoài limiter.
 */
export async function probeReadiness(
  env: LlmApiEnv,
  limiters: Readonly<Record<BindingName, BindingLimiter>>,
): Promise<ReadinessReport> {
  const [gateway, tenant, marketplace] = await Promise.all(
    BINDING_NAMES.map(async (binding) => probeBinding(env, binding, limiters[binding])),
  );
  return { gateway, tenant, marketplace };
}

async function probeBinding(
  env: LlmApiEnv,
  binding: BindingName,
  limiter: BindingLimiter,
): Promise<BindingStatus> {
  const hyperdrive = readBinding(env, binding);
  if (hyperdrive === null) {
    return 'missing';
  }
  try {
    await withClient(hyperdrive.connectionString, (client) => client.query('SELECT 1'), {
      limiter,
      deadlineMs: READINESS_DEADLINE_MS,
    });
    return 'ready';
  } catch (error) {
    // Hai nhãn khác nhau của hợp đồng readiness (đúng semantics Rust):
    // deadline hết → `timeout` (operation đã bị terminate thật — review P1
    // của PR #152); mọi lỗi khác (connection lỗi, queue admission đầy) →
    // `unavailable`. HTTP body không đổi: một binding chưa ready là 503.
    return error instanceof OperationDeadlineError ? 'timeout' : 'unavailable';
  }
}
