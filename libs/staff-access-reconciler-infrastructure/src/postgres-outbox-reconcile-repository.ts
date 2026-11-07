import type { Pool } from 'pg';

import type {
  OutboxReconcileRepository,
  StalePublishedEvent,
  ListStalePublishedInput,
} from '@ecoma-io/staff-access-reconciler-application';
import { MAX_RECONCILIATION_LIMIT } from '@ecoma-io/staff-access-reconciler-application';

interface RawStaleRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly occurred_at: Date | string;
  readonly published_at: Date | string;
  readonly attempts: number | string;
  readonly last_error: string | null;
  readonly settled_at: Date | string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isoNullable(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Sanitize relay `last_error` tại infrastructure boundary — ranh giới duy nhất
 * được phép trả raw error qua port.
 *
 * ⚠️ **Hard contract (xem `outbox-reconcile-repository.ts`).** Application layer
 * không enforce invariant này; adapter throw fail-closed nếu row vi phạm, nó
 * KHÔNG bao giờ trả raw error. Sanitize:
 *   - loại bỏ ký tự điều khiển (không giữ newline/tab — diagnostics là một dòng).
 *   - từ chối raw SQL fragment (SELECT/INSERT/UPDATE/DELETE/FROM/WHERE/...) và
 *     stack trace pattern (`at ...`, `Error:`, `file.js:line:col`) — thay bằng
 *     `[redacted]`.
 *   - cắt độ dài tối đa `MAX_RELAY_ERROR_LEN` (255) để không lây lan vào metric
 *     label hay log line dài.
 */
const MAX_RELAY_ERROR_LEN = 255;

/**
 * Loại bỏ ký tự điều khiển (kể cả newline/tab) thành một khoảng trắng —
 * diagnostics là một dòng, không được nhảy dòng (tránh log injection).
 */
// eslint-disable-next-line no-control-regex -- intentional: strip control chars.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/gu;

/**
 * Combined "reject anything suspicious" pattern: raw SQL fragments, stack
 * traces, JS/TS error-type prefixes, PostgreSQL schema/constraint details,
 * Python tracebacks, file paths and line numbers. Anything matching is
 * replaced with `[redacted]` — mặc định là redact thay vì liệt kê mọi pattern
 * an toàn (denylist cũ bỏ lừa TypeError, ReferenceError, lỗi schema PG, v.v.).
 * Built with `new RegExp(...)` (string form) instead of a regex literal so the
 * oxc transform never chokes on the multiline alternation.
 */
const SUSPICIOUS_PATTERN = new RegExp(
  '(' +
    '\\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|VALUES|DROP|ALTER|CREATE|TRUNCATE|COPY|GRANT|REVOKE|EXEC|EXECUTE)\\b|' +
    '\\bat\\s+\\S+|' +
    '\\bError:|' +
    '\\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|AggregateError):|' +
    '\\bTraceback\\b|' +
    'File\\s+"[^"]*"|' +
    '\\bPG::|' +
    'column\\s+"[^"]*"\\s+of\\s+relation\\s+"[^"]*"|' +
    'duplicate\\s+key\\s+value\\s+violates|' +
    '\\.(?:js|ts|mjs|cjs):\\d+:\\d+|' +
    '(?:^|[^\\w/])\\.\\.?\\/' +
    ')',
  'iu',
);

function sanitizeRelayError(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const stripped = raw.replace(CONTROL_CHARS, ' ');
  if (SUSPICIOUS_PATTERN.test(stripped)) {
    return '[redacted]';
  }
  return stripped.length > MAX_RELAY_ERROR_LEN
    ? `${stripped.slice(0, MAX_RELAY_ERROR_LEN)}…`
    : stripped;
}

export function createPostgresOutboxReconcileRepository(pool: Pool): OutboxReconcileRepository {
  return {
    async listStalePublished(
      input: ListStalePublishedInput,
    ): Promise<readonly StalePublishedEvent[]> {
      // ⚠️ Chỉ SELECT — không UPDATE/claim/redrive. Runtime role đã có SELECT
      // trên bảng (migration 0004), không cần grant mới.
      //
      // Điều kiện stale: published_at IS NOT NULL AND published_at < now - staleAfterMs.
      // `attempts`/`last_error` chỉ để chẩn đoán, không phải lệnh replay.
      //
      // ⚠️ `limit` clamp defensively: trong PostgreSQL, `LIMIT -1` (hoặc giá trị
      // âm) có nghĩa là không giới hạn số row. Application layer
      // (`runReconciliationCycle`) đã validate `limit ≥ 1` fail-fast, nhưng port
      // này là public API — caller khác có thể gọi trực tiếp. Clamp ở đây là
      // lớp thứ hai: giá trị không hợp lệ → throw (fail-closed, không silently
      // quét toàn bộ bảng), giá trị hợp lệ → dùng nguyên vẹn.
      if (!Number.isInteger(input.limit) || input.limit < 1) {
        throw new Error(`outbox reconcile limit must be a positive integer: ${input.limit}`);
      }
      if (input.limit > MAX_RECONCILIATION_LIMIT) {
        throw new Error(
          `outbox reconcile limit must not exceed ${MAX_RECONCILIATION_LIMIT}: ${input.limit}`,
        );
      }
      // ⚠️ `staleAfterMs` phải là số nguyên không âm. Trong PostgreSQL, cutoff
      // = now - staleAfterMs, và `published_at < cutoff` — nếu staleAfterMs âm,
      // cutoff sẽ pushed vào tương lai, coi TẤT CẢ published row là stale (kể cả
      // row vừa publish), làm job quét toàn bộ outbox mỗi lần. Application layer
      // (`runReconciliationCycle`) validate fail-fast trước khi truyền xuống port,
      // nhưng port này là public API — caller khác có thể gọi trực tiếp. Throw
      // fail-closed (không silently clamp về 0) để match style của `limit` ở trên.
      if (!Number.isInteger(input.staleAfterMs) || input.staleAfterMs < 0) {
        throw new Error(
          `outbox reconcile staleAfterMs must be a non-negative integer: ${input.staleAfterMs}`,
        );
      }
      // ⚠️ `nowMs` phải là một số hữu hạn trước khi tính cutoff — NaN/Infinity
      // làm `new Date(nowMs)` thành Invalid Date và cutoff lan truyền vào SQL.
      if (!Number.isFinite(input.nowMs)) {
        throw new Error(`outbox reconcile nowMs must be a finite number: ${input.nowMs}`);
      }
      const cutoff = new Date(input.nowMs - input.staleAfterMs).toISOString();
      const result = await pool.query<RawStaleRow>(
        `SELECT event_id, event_type, occurred_at, published_at, attempts, last_error, settled_at
           FROM staff_access.entitlement_outbox_events
          WHERE published_at IS NOT NULL
            AND settled_at IS NULL
            AND published_at < $1::timestamptz
          ORDER BY published_at
          LIMIT $2`,
        [cutoff, input.limit],
      );
      return result.rows.map((raw) => {
        const attempts = Number(raw.attempts);
        // ⚠️ `attempts` là `number | string` từ driver — một chuỗi không phải số
        // (hoặc giá trị rác) ép qua `Number` thành NaN, làm schema event hỏng.
        // Guard fail-closed: NaN → 0 (không bao giờ để NaN lọt vào payload).
        if (!Number.isFinite(attempts)) {
          throw new Error(`outbox reconcile attempts must be a number: ${raw.attempts}`);
        }
        return {
          event_id: raw.event_id,
          event_type: raw.event_type,
          occurred_at: iso(raw.occurred_at),
          published_at: iso(raw.published_at),
          attempts,
          last_error: sanitizeRelayError(raw.last_error),
          settled_at: isoNullable(raw.settled_at),
        };
      });
    },
  };
}
