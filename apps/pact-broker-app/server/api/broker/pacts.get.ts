import { defineEventHandler, setResponseStatus } from 'h3';

import { brokerCall } from '../../utils/broker-client';
import { pactBrokerBffConfig } from '../../utils/broker-config';

/**
 * `GET /api/broker/pacts` — ma trận consumer/provider/version cho trang Pacts,
 * dựng bằng **composition phía BFF** từ các endpoint đã có contract (issue
 * #181).
 *
 * Vì sao composition: `/matrix` của API đòi ít nhất một selector `pacticipant`
 * (400 khi thiếu — `apps/pact-broker-api/src/routes/matrix.ts`), còn dashboard
 * cần "toàn bộ quan hệ đang có". BFF không tự chế endpoint mới và không đổi
 * contract của API:
 *
 * 1. Liệt kê pacticipants của tenant qua `GET /pacticipants`.
 * 2. Gọi `GET /matrix` ĐÚNG MỘT LẦN với selector lặp
 *    `q[][pacticipant]=<tên>` — API tự union + dedup các selector và trả ma
 *    trận đủ cho bảng render.
 *
 * Không có pacticipant nào ⇒ BFF trả ma trận rỗng 200 ngay lập tức: API không
 * có contract cho truy vấn zero-selector, và một broker chưa có dữ liệu là
 * trạng thái rỗng thật của dashboard, không phải lỗi upstream.
 *
 * Mỗi hop giữ đúng luật lỗi chung của BFF: status của API truyền nguyên văn,
 * transport hỏng ⇒ 502 qua `brokerCall`.
 */

/**
 * Danh sách tên pacticipant từ HAL body của `/pacticipants` — shape lạ hoặc
 * field không phải string đều rơi về rỗng; dữ liệu hiển thị trống không được
 * biến thành exception trắng trang.
 */
export function pacticipantNamesOf(body: unknown): string[] {
  // Access bằng bracket-string cho khoá HAL — property `_embedded` vi phạm
  // no-underscore-dangle ở dot notation (cùng pattern api.spec.ts của API).
  const embedded = (body as Record<string, unknown> | null)?.['_embedded'] as
    | { pacticipants?: unknown }
    | undefined;
  const rows = Array.isArray(embedded?.pacticipants) ? embedded.pacticipants : [];
  const names = new Set<string>();
  for (const row of rows) {
    const name = (row as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name !== '') {
      names.add(name);
    }
  }
  return [...names];
}

/** Body ma trận rỗng cho một broker chưa có pacticipant nào. */
const EMPTY_MATRIX = { matrix: [] } as const;

export default defineEventHandler(async (event) => {
  // ⚠️ `useRuntimeConfig(event)` (auto-import của Nitro), KHÔNG phải
  // `event.context.runtimeConfig`: slot đó không ai gắn trên runtime thật —
  // dùng nó là 503 vĩnh viễn kể cả khi đã cấu hình (sửa trong issue #181).
  // Truyền `event` bắt buộc: trên Workers, env được nối vào runtime config
  // theo request qua `globalThis.__env__`; config đọc lúc module load thì rỗng
  // (cùng pattern `apps/account/server/routes/internal/account/status.get.ts`).
  const config = pactBrokerBffConfig(useRuntimeConfig(event));
  if (config === null) {
    setResponseStatus(event, 503);
    return { error: 'Service Unavailable', code: 'broker_not_configured' };
  }

  // Hop 1 — liệt kê pacticipants của tenant.
  const list = await brokerCall(config, '/pacticipants');
  if (list.errorCode !== null || list.status !== 200) {
    setResponseStatus(event, list.errorCode !== null ? 502 : list.status);
    return list.body ?? { error: 'broker_unreachable' };
  }

  const names = pacticipantNamesOf(list.body);
  if (names.length === 0) {
    // 200 tường minh cho đồng nhất với mọi nhánh khác trong file — broker rỗng
    // là thành công thật, không phải rơi vào default ngầm của h3.
    setResponseStatus(event, 200);
    return EMPTY_MATRIX;
  }

  // Hop 2 — một lần `/matrix` với selector lặp cho từng pacticipant.
  const params = new URLSearchParams();
  for (const name of names) {
    params.append('q[][pacticipant]', name);
  }
  const result = await brokerCall(config, `/matrix?${params.toString()}`);
  setResponseStatus(event, result.errorCode !== null ? 502 : result.status);
  return result.body ?? { error: 'broker_unreachable' };
});
