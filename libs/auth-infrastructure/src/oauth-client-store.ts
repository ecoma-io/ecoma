import type { RegisteredClient } from '@ecoma-io/auth-application';

import type { PostgresClientLike } from './postgres';

/**
 * Store client đăng ký của `db-auth` — bảng `auth.oauth_clients` +
 * `auth.client_redirect_uris`.
 *
 * ## Ranh giới
 *
 * Truy vấn này từng nằm trong `apps/auth/src/authorization-store.ts` — chỗ tạm
 * của app cho tới khi lib sở hữu nó (#343). Cùng bộ luật với các module anh em
 * (`authorization-code-cas`, `authorization-transaction-store`): câu SQL là
 * bản chép của quy ước trong migration `0001`, lệch tên cột chỉ lộ ra khi chạy
 * với schema thật.
 *
 * ## Parity test
 *
 * Bảng ở trên KHÔNG có parity spec colocated song song từng file migration;
 * hợp đồng đọc của nó được ghim bằng suite PostgreSQL thật app-owned
 * `apps/auth/tests/integrations/authorization-store.spec.ts` (+ các đường
 * handler qua `main.spec.ts`). Quyết định này giữ nguyên khi store dời về lib
 * — suite sở hữu database thuộc app, không thuộc lib (06-testing.md §6, §9).
 */

/** Hàng `oauth_clients` + redirect URI gom sẵn — hình dạng `findClient` trả. */
interface ClientRow {
  client_id: string;
  client_type: string;
  status: string;
  allowed_scopes: string[];
  redirect_uris: string[];
}

/**
 * Nạp client đăng ký kèm mọi redirect URI và scope được phép.
 *
 * ⚠️ Chỉ trả client khi còn `active`: một client `disabled` KHÔNG được đi qua
 * `/authorize`, kể cả khi mọi tham số đúng (`assertUsableClient`). Nạp về rồi
 * lọc ở tầng trên cũng được — nhưng nạp về một hàng disabled để tầng trên
 * quyết định là làm `findClient` thành "tra bảng", còn lọc ở đây làm nó thành
 * "tra bảng HỢP LỆ". Đặt chính sách vào đúng một tầng.
 */
export async function findRegisteredClient(
  client: PostgresClientLike,
  clientId: string,
): Promise<RegisteredClient | undefined> {
  const rows = await client.unsafe<ClientRow>(
    `SELECT c.client_id, c.client_type, c.status,
            c.allowed_scopes,
            coalesce(array_agg(r.redirect_uri ORDER BY r.redirect_uri)
                      FILTER (WHERE r.redirect_uri IS NOT NULL), '{}') AS redirect_uris
       FROM auth.oauth_clients c
       LEFT JOIN auth.client_redirect_uris r ON r.client_id = c.client_id
      WHERE c.client_id = $1
      GROUP BY c.client_id, c.client_type, c.status, c.allowed_scopes`,
    [clientId],
  );
  const row = rows[0];
  if (row === undefined || row.status !== 'active') {
    return undefined;
  }
  return {
    client_id: row.client_id,
    client_type: row.client_type === 'confidential' ? 'confidential' : 'public',
    redirect_uris: row.redirect_uris,
    allowed_scopes: row.allowed_scopes,
    isActive: true,
  };
}
