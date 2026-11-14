/**
 * Khung chung của 3 read route (`/api/staff`, `/api/roles`,
 * `/api/permissions`) — issue #99.
 *
 * ## Vì sao có một khung
 *
 * Ba route có **cùng** đường đi: đọc principal server-side → đọc binding DB →
 * dựng pool → đọc ảnh assignment → `requirePermission` → đọc dữ liệu →
 * trả JSON. Ba bản sao của đường đi đó là ba chỗ để quên một nhánh fail-closed
 * (đặc biệt nhánh `503` khi DB unreachable và nhánh audit trước khi `403`), và
 * "đường đi giống nhau" là điều kiện để test dùng chung một bộ case cho cả
 * ba route.
 *
 * ⚠️ Khung này **không** gom việc đọc dữ liệu: mỗi route vẫn tự gọi query
 * của mình (staff / roles / permissions là ba bảng khác nhau), và mỗi route
 * tự khai permission của mình. Khung chỉ gom phần **giống nhau**:
 * principal, pool, ảnh assignment, enforcement, mapping lỗi.
 *
 * ## Thứ tự fail-closed
 *
 * 1. Principal không verify được ⇒ `401` (ADR-0011 §1 — caller chưa đăng
 *    nhập; middleware authn gắn principal trước route, vắng nghĩa là không có
 *    phiên) — trước cả việc mở pool.
 * 2. Binding `DB_BACKOFFICE` vắng ⇒ `503` — Worker chưa có DB thì không có
 *    đường đọc nào trả lời được.
 * 3. `requirePermission` deny ⇒ `403` **sau khi** audit đã ghi (audit trước
 *    throw là quy tắc của workstream B, module này không sửa).
 * 4. DB unreachable giữa chừng ⇒ `503`.
 *
 * ## Nguồn quyết định authorization — cutover (issue #241)
 *
 * Ảnh assignment được đọc từ HAI nguồn: legacy `db-backoffice` (shadow) và
 * projection Staff Access qua client binding `STAFF_ACCESS_SERVICE`. Sau mốc
 * `AUTHZ_PROJECTION_CUTOVER_ENV` (ISO-8601, giá trị do deploy layer cấp —
 * ADR-0023 Quyết định 2: verdict permission do Staff Access sở hữu) projection
 * còn tươi là nguồn quyết định; cutover bật mà projection không có/quá TTL thì
 * fallback legacy **kèm log** — không chọn im lặng. Allow của phép đọc có bảo
 * vệ ghi thêm một audit row `success` (SR-013 — privileged operation audit).
 */

import { createError, type H3Event } from 'h3';
import type { Pool, PoolClient } from 'pg';

import type { CatalogPermission } from '@ecoma-io/backoffice-domain';
import {
  AUTHZ_PROJECTION_CUTOVER_ENV,
  loadPrincipalAuthorization,
  loadPrincipalAuthorizationProjection,
  recordPrivilegedSuccess,
  staffAccessClientConfig,
  withBackofficePool,
} from '@ecoma-io/backoffice-infrastructure';

import { requirePermission, type PrincipalAuthorization } from './authorization';
import { poolBinding, readWorkerEnv } from './db';
import { requirePrincipal } from './principal';
import { writeLog } from './log';

/**
 * Đọc ảnh assignment của principal bằng **một** client của pool — cùng một
 * connection cho ảnh assignment và audit. `requirePermission` nhận `Client`
 * của `pg` (không phải `Pool`), nên callback lấy client này rồi `release()`
 * trong `finally` — connection trở về pool kể cả khi callback ném, không rò
 * connection tới khi pool cạn.
 */
async function withPoolClient<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

/**
 * Chạy phần đọc của một read route dưới enforcement.
 *
 * @param permission Permission catalog mà route hỏi — **định danh có thật
 *   trong catalog** (SR-020/invariant 10): `staff.read` / `role.read` /
 *   `permission.read`, seed ở `0003_permission_catalog_seed.sql` theo
 *   ADR-0010.
 * @param read Hàm đọc dữ liệu — nhận client của **runtime role** (credential
 *   Hyperdrive), trả payload của route.
 */
export async function withReadEnforcement<T>(
  event: H3Event,
  permission: CatalogPermission,
  read: (client: PoolClient) => Promise<T>,
): Promise<T> {
  // 1. Principal — không có phiên hợp lệ thì `401` (ADR-0011 §1), chưa mở pool.
  const principal = requirePrincipal(event);

  // 2. Binding — Worker chưa có DB thì `503`, không phải "trả rỗng". Cùng
  //    một nguồn kép với middleware authn (`poolBinding`): Hyperdrive trước,
  //    runtime Node local sau — lệch nguồn là read route chết 503 trên local
  //    trong khi authn vẫn chạy (bug thật của suite e2e, đã sửa tại `db.ts`).
  const binding = poolBinding(event);
  if (binding === null) {
    throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
  }

  try {
    return await withBackofficePool(binding, (pool) =>
      withPoolClient(pool, async (client) => {
        // 3. Ảnh assignment — dual-read với cutover gate (issue #241).
        //
        // Legacy path (db-backoffice) vẫn được đọc làm shadow; projection từ
        // Staff Access là nguồn quyết định sau mốc cutover. Hai kết quả được so
        // sánh; mismatch được log — không bao giờ im lặng chọn một trong hai.
        const legacy = await loadPrincipalAuthorization(client, principal.actorSub);

        const env = readWorkerEnv(event);
        const staffConfig = env === null ? null : staffAccessClientConfig(env);
        let projection = null;
        let projectionUnavailableReason: 'client_unconfigured' | 'projection_fetch_failed' | null =
          null;
        if (staffConfig !== null) {
          try {
            projection = await loadPrincipalAuthorizationProjection(
              staffConfig,
              principal.actorSub,
            );
          } catch {
            projection = null;
          }
          if (projection === null) {
            projectionUnavailableReason = 'projection_fetch_failed';
          }
        } else {
          projectionUnavailableReason = 'client_unconfigured';
        }

        // Dual-read comparison harness — log mismatch, không chọn im lặng.
        if (projection !== null) {
          const legacyKey = JSON.stringify(legacy.assignments);
          const projectionKey = JSON.stringify(projection.assignments);
          if (legacyKey !== projectionKey) {
            writeLog({
              event: 'backoffice.authz.dual_read_mismatch',
              route: event.path ?? '',
              method: 'GET',
              sub: principal.actorSub,
              reason: 'legacy_vs_projection',
            });
          }
        }

        // Freshness gate: projection chỉ được tin khi còn trong TTL của risk class
        // `normal` (60s — ADR-0002). Projection quá hạn ⇒ fallback legacy + log,
        // không im lặng chọn ảnh cũ.
        const projectionFresh =
          projection !== null && Date.now() - projection.fetchedAt.getTime() <= 60_000;

        if (projection !== null && !projectionFresh) {
          writeLog({
            event: 'backoffice.authz.projection_stale',
            route: event.path ?? '',
            method: 'GET',
            sub: principal.actorSub,
            reason: 'projection_ttl_exceeded',
          });
        }

        // Cutover gate: projection trở thành quyết định hiện hành khi env
        // `BACKOFFICE_AUTHZ_PROJECTION_CUTOVER_AT` (ISO-8601, giá trị do deploy
        // layer cấp — hằng tên ở `AUTHZ_PROJECTION_CUTOVER_ENV`) đã tới VÀ
        // projection còn tươi (issue #241).
        const envRecord =
          typeof env === 'object' && env !== null ? (env as Record<string, unknown>) : null;
        const cutoverAtRaw = envRecord?.[AUTHZ_PROJECTION_CUTOVER_ENV];
        const cutoverAt = typeof cutoverAtRaw === 'string' ? Date.parse(cutoverAtRaw) : NaN;
        const cutoverEnabled = Number.isFinite(cutoverAt) && Date.now() >= cutoverAt;

        const useProjection = cutoverEnabled && projection !== null && projectionFresh;

        // Cutover đã bật mà projection KHÔNG có ⇒ fallback legacy **kèm log** —
        // không chọn im lặng (ràng buộc của issue #241). Legacy rỗng vẫn deny
        // (fail-closed giữ nguyên chiều an toàn); log là dấu vết điều tra cho
        // việc "quyết định không đến từ nguồn đã chọn".
        if (cutoverEnabled && projection === null && projectionUnavailableReason !== null) {
          writeLog({
            event: 'backoffice.authz.projection_unavailable',
            route: event.path ?? '',
            method: 'GET',
            sub: principal.actorSub,
            reason: projectionUnavailableReason,
          });
        }

        const principalAuthorization: PrincipalAuthorization = {
          assignments:
            useProjection && projection !== null ? projection.assignments : legacy.assignments,
          actorSub: principal.actorSub,
        };

        // 4. Enforcement — deny ⇒ `403` sau khi audit đã ghi (module của
        //    workstream B, không sửa ở đây).
        await requirePermission(permission, principalAuthorization, client);

        // 4b. Audit success của phép đọc có bảo vệ (issue #241): allow của
        //     route permission-gated là privileged operation theo SR-013 —
        //     allow cũng phải để lại dấu vết như deny. Ghi TRƯỚC khi đọc dữ
        //     liệu, cùng client; lỗi INSERT propagate ⇒ 503 (I-08 — lỗi audit
        //     không được nuốt).
        await recordPrivilegedSuccess(client, {
          actorSub: principal.actorSub,
          operation: permission,
        });

        // 5. Đọc dữ liệu của route — cùng client với enforcement.
        return read(client);
      }),
    );
  } catch (error) {
    return failClosedOnDatabaseError(error);
  }
}

/**
 * Dịp lỗi DB thành `503`.
 *
 * ⚠️ `requirePermission` ném `H3Error` có `statusCode` — lỗi đó đã là câu trả
 * lời cuối cùng của route (403/503) và **không** được đổi thành 503. Vì vậy
 * hàm này chỉ bắt lỗi **không** phải `H3Error`: đó là lỗi driver (`pg`) hoặc
 * lỗi hình dạng dữ liệu, và cả hai đều là "không trả lời được" ⇒ `503`.
 *
 * ⚠️ **Không** nối message của lỗi vào log/response: message của `pg` có thể
 * chứa connection string.
 */
export function failClosedOnDatabaseError(error: unknown): never {
  if (isHttpError(error)) {
    throw error;
  }
  throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
}

/**
 * Kiểm lỗi có phải `H3Error` (đã mang `statusCode`) không.
 *
 * Không dùng `instanceof` vì `h3` có thể bị bundle lại thành nhiều bản khác
 * nhau trong bundle Worker — nhận diện theo **hình dạng** (`statusCode` là số)
 * là cách bền qua bundle boundary.
 */
function isHttpError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
  );
}
