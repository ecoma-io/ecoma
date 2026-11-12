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
import type { LlmApiEnv } from './env';
import {
  BINDING_GATEWAY,
  BINDING_NAMES,
  BINDING_MARKETPLACE,
  BINDING_TENANT,
  readBinding,
} from './env';
import { withClient } from './connections';

/**
 * Deadline per-binding của probe readiness (per-operation deadline — một trong
 * ba knob timeout, xem `connections.ts`). Đủ ngắn để `/ready` không treo, đủ dài cho
 * connection thật qua Hyperdrive local emulation.
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
function statusOf(report: ReadinessReport, binding: string): BindingStatus {
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
 * Kết quả một probe có deadline: `timedOut` phân biệt deadline tự bắn với lỗi
 * thật của connection (hai trạng thái khác nhau của hợp đồng readiness).
 */
interface ProbeOutcome {
  readonly timedOut: boolean;
  readonly ok: boolean;
}

const DEADLINE_HIT: ProbeOutcome = { timedOut: true, ok: false };

/**
 * Probe song song cả ba binding, mỗi probe có deadline riêng 3s. Binding thiếu
 * trong env là `missing` — fail-closed, không bao giờ suy đoán.
 */
export async function probeReadiness(env: LlmApiEnv): Promise<ReadinessReport> {
  const [gateway, tenant, marketplace] = await Promise.all(
    BINDING_NAMES.map(async (binding) => probeBinding(env, binding)),
  );
  return { gateway, tenant, marketplace };
}

async function probeBinding(env: LlmApiEnv, binding: string): Promise<BindingStatus> {
  const hyperdrive = readBinding(env, binding);
  if (hyperdrive === null) {
    return 'missing';
  }
  const outcome = await withDeadline(
    withClient(hyperdrive.connectionString, (client) => client.query('SELECT 1')),
  );
  if (outcome.timedOut) {
    return 'timeout';
  }
  return outcome.ok ? 'ready' : 'unavailable';
}

/**
 * Đua một query với deadline của nó: deadline thắng là `DEADLINE_HIT` (probe
 * kết luận `timeout`), query thắng là kết quả thật. `Promise.race` gắn handler
 * vào cả hai promise nên rejection "thua cuộc" đến muộn không thành
 * unhandled rejection.
 */
async function withDeadline(query: Promise<unknown>): Promise<ProbeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ProbeOutcome>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_HIT), READINESS_DEADLINE_MS);
  });
  try {
    return await Promise.race([query.then(() => ({ timedOut: false, ok: true })), deadline]);
  } catch {
    return { timedOut: false, ok: false };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
