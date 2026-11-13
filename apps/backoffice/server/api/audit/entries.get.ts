/**
 * `GET /api/audit/entries` — truy vấn bản ghi authorization audit của Staff Access,
 * qua management API (`GET /audit/entries`).
 *
 * ⚠️ **Vị trí file là một phần của hợp đồng.** Trước P5.4-route-fix (#182), file
 * này nằm ở `server/api/audit.get.ts` — Nitro mount nó tại `/api/audit`, trong khi
 * adapter thật (`app/backoffice-data/real-adapter.ts`) gọi `/api/audit/entries`:
 * mọi lần đọc ở chế độ realtime rơi vào catch-all `apiNotFound` ⇒ 404. Chuyển
 * sang `server/api/audit/entries.get.ts` đưa route mount khớp lại đúng hợp đồng
 * mà cả adapter lẫn spec đều đã gọi; URL hợp đồng không đổi.
 *

 * ## Thay đổi P5.4 (issue #478)
 *
 * Route mới trong workstream C: hiển thị vết nhảy của các thao tác nhạy cảm quyền
 * (actor, target, action, thời điểm, kết quả, lý do) trên trang audit trail của
 * backoffice. Dữ liệu audit thuộc bounded context `staff-access` (ADR-0013);
 * backoffice chỉ là composition/UI + BFF.
 *
 * Đây là route **QUERY-ONLY** — không có request ghi (SR-015: audit append-only,
 * append diễn ra server-side nội bộ Staff Access khi privileged operation diễn ra).
 * Một request append qua đây là mở đường ghi đè/che dấu vết, phá đúng invariant
 * append-only.
 *
 * Permission: `audit.read` — định danh có thật trong sealed catalog
 * (`0003_permission_catalog_seed.sql`, ADR-0010). Không phát minh permission.
 *
 * Query params: toàn bộ tuỳ chọn, kết hợp AND — `actor_staff_id`, `actor_sub`,
 * `target`, `action`, `occurred_from`, `occurred_to`, `correlation_id`, `limit`,
 * `cursor`. Truyền thẳng qua Staff Access management API qua `fetchAuditEntries`.
 *
 * Fail-closed: principal không verify được ⇒ `401` (ADR-0011); binding
 * `STAFF_ACCESS_SERVICE` vắng / secret vắng ⇒ `503`; `can()` deny ⇒ `403` sau
 * khi audit đã ghi. Staff-access không trả lời được ⇒ `503`. Xem
 * {@link withReadEnforcement}.
 */

import { createError, defineEventHandler, getQuery } from 'h3';

import {
  fetchAuditEntries,
  listAuthorizationAudit,
  staffAccessClientConfig,
} from '@ecoma-io/backoffice-infrastructure';
import { readWorkerEnv } from '../../db';
import { withReadEnforcement } from '../../read-route';

/** Lấy query params từ request, chỉ giữ các key hợp lệ của hợp đồng audit query. */
function auditQueryFromQuery(event: import('h3').H3Event): Record<string, string> {
  const query = getQuery(event);
  const allowed: readonly string[] = [
    'actor_staff_id',
    'actor_sub',
    'target',
    'action',
    'occurred_from',
    'occurred_to',
    'correlation_id',
    'limit',
    'cursor',
  ];
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const value = query[key];
    if (typeof value === 'string' && value.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

export default defineEventHandler((event) =>
  withReadEnforcement(event, 'audit.read', async (client) => {
    const env = readWorkerEnv(event);
    const config = env === null ? null : staffAccessClientConfig(env);

    const query = auditQueryFromQuery(event);
    const remoteEntries =
      config === null
        ? []
        : await (async (): Promise<
            readonly import('@ecoma-io/staff-access-contracts').AuditEntry[]
          > => {
            const result = await fetchAuditEntries(config, query);
            if (!result.ok) {
              throw createError({ statusCode: 503, statusMessage: 'audit entries unavailable' });
            }
            return result.entries;
          })();

    // Surface local authorization decisions/denials alongside Staff Access entries.
    const local = await listAuthorizationAudit(client, 50);

    const merged = [
      ...remoteEntries.map((entry) => ({
        id: entry.id,
        actor_staff_id: entry.actor_staff_id ?? null,
        actor_sub: entry.actor_sub ?? null,
        target: entry.target,
        action: entry.action,
        occurred_at: entry.occurred_at,
        outcome: entry.outcome,
        source: 'staff-access' as const,
        ...(entry.reason !== undefined && entry.reason !== null ? { reason: entry.reason } : {}),
        ...(entry.correlation_id !== undefined && entry.correlation_id !== null
          ? { correlation_id: entry.correlation_id }
          : {}),
      })),
      ...local.map((entry) => ({
        id: entry.id,
        actor_staff_id: null,
        actor_sub: entry.actor_sub,
        target: entry.target_sub ?? '',
        action: entry.action,
        occurred_at: entry.occurred_at,
        outcome: entry.outcome,
        source: 'local' as const,
        ...(entry.reason_code !== null ? { reason: entry.reason_code } : {}),
        ...(entry.correlation_id !== null ? { correlation_id: entry.correlation_id } : {}),
      })),
    ];

    return { entries: merged };
  }),
);
