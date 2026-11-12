/**
 * Catalogue model của `/v1/models` (Issue #23): đọc offer `active` từ binding
 * marketplace, ánh xạ `seller_tenant_id` → tên tenant công khai từ binding
 * gateway, trả về đúng hợp đồng OpenAI-compatible
 * `{"object":"list","data":[{"id","object":"model","created","owned_by"}]}`.
 *
 * Quy tắc fail-closed (ADR-0027 §7, domain-model llm-marketplace §8):
 * - Chỉ offer `active` được liệt kê; offer `draft` chưa từng được probe khỏe
 *   và chưa có verdict eligible nên không bao giờ xuất hiện.
 * - Offer `active` mà `seller_tenant_id` không ánh xạ được sang tenant ở
 *   gateway ⇒ lỗi catalogue ⇒ route trả 503 (không liệt kê "mù" một model
 *   với owner không xác thực được).
 * - Lỗi query trên một trong hai binding ⇒ 503, không fallback danh sách rỗng
 *   giả tạo.
 *
 * Bất biến platform: KHÔNG BAO GIỜ log connection string, credential hay body.
 * Log chỉ cấu trúc tối thiểu.
 */
import type { LlmApiEnv } from './env';
import { BINDING_GATEWAY, BINDING_MARKETPLACE, readBinding } from './env';
import { withClient } from './connections';

/** Một model đang phục vụ trong catalogue công khai. */
export interface ServingModel {
  /** Normalized model id — định danh công khai trên `/v1/models`. */
  readonly id: string;
  /** Thời điểm offer được tạo, quy đổi ra giây epoch (quy ước OpenAI). */
  readonly created: number;
  /** Tên Seller tenant sở hữu offer — định danh công khai của owner. */
  readonly ownedBy: string;
}

/** Lỗi catalogue — chi tiết lỗi không bao giờ đi vào log (tránh lộ connection
 * string/credential qua thông báo lỗi); route chỉ cần biết "lỗi" để fail-closed. */
export class CatalogueError extends Error {
  constructor() {
    super('model catalogue query failed');
    this.name = 'CatalogueError';
  }
}

/** SQL catalogue marketplace — KHÔNG đổi chữ (hợp đồng đóng băng, so khớp
 * từng ký tự với `src/models.rs` của runtime Rust). */
const ACTIVE_OFFERS_SQL =
  "SELECT normalized_model_id, created_at, seller_tenant_id FROM llm_marketplace.model_offers WHERE status = 'active' ORDER BY created_at, normalized_model_id";

/** SQL ánh xạ tenant gateway — KHÔNG đổi chữ (hợp đồng đóng băng). */
const TENANT_NAMES_SQL = 'SELECT id, name FROM llm_seller.seller_tenants';

/** Một offer `active`: (normalized model id công khai, created_at millis, seller_tenant_id). */
interface ActiveOffer {
  readonly id: string;
  readonly createdAtMillis: number;
  readonly sellerTenantId: string;
}

/**
 * Escape một chuỗi thành JSON string literal (không bao gồm dấu ngoặc kép bao
 * ngoài). Port từng ký tự của `json_escape` (Rust `src/models.rs`): escape
 * `"`, `\`, `\n`, `\r`, `\t` và mọi control character thành `\u` 4-hex thấp —
 * để body JSON byte-tương-thích với runtime Rust.
 */
export function jsonEscape(value: string): string {
  let escaped = '';
  for (const character of value) {
    switch (character) {
      case '"':
        escaped += '\\"';
        break;
      case '\\':
        escaped += '\\\\';
        break;
      case '\n':
        escaped += '\\n';
        break;
      case '\r':
        escaped += '\\r';
        break;
      case '\t':
        escaped += '\\t';
        break;
      default: {
        const code = character.codePointAt(0) ?? 0;
        // Rust `char::is_control()` = class Cc: U+0000–U+001F và U+007F–U+009F.
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
          escaped += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          escaped += character;
        }
      }
    }
  }
  return escaped;
}

/**
 * Dựng body JSON của `/v1/models` — hàm thuần để unit test. Thứ tự key và
 * dấu phẩy phân tách khớp byte với runtime Rust (`models_list_body`).
 */
export function modelsListBody(models: readonly ServingModel[]): string {
  const items = models
    .map(
      (model) =>
        `{"id":"${jsonEscape(model.id)}","object":"model","created":${model.created},"owned_by":"${jsonEscape(model.ownedBy)}"}`,
    )
    .join(',');
  return `{"object":"list","data":[${items}]}`;
}

/**
 * Chạy một câu lệnh đọc qua binding tương ứng (client pg mới cho mỗi phép
 * gọi — xem `connections.ts`); mọi lỗi (binding thiếu, query lỗi) đều ném
 * `CatalogueError` — chi tiết lỗi không bao giờ đi vào log.
 */
async function queryBinding(
  env: LlmApiEnv,
  binding: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const hyperdrive = readBinding(env, binding);
  if (hyperdrive === null) {
    throw new CatalogueError();
  }
  try {
    const result = await withClient(hyperdrive.connectionString, (client) => client.query(sql));
    return result.rows as Record<string, unknown>[];
  } catch {
    throw new CatalogueError();
  }
}

/** Đọc các offer `active` từ binding marketplace. */
async function fetchActiveOffers(env: LlmApiEnv): Promise<ActiveOffer[]> {
  const rows = await queryBinding(env, BINDING_MARKETPLACE, ACTIVE_OFFERS_SQL);
  return rows.map((row) => {
    const id = row.normalized_model_id;
    const createdAt = row.created_at;
    const sellerTenantId = row.seller_tenant_id;
    if (typeof id !== 'string' || typeof sellerTenantId !== 'string') {
      throw new CatalogueError();
    }
    // `created_at` là BIGINT: `pg` trả về chuỗi — parse sai là lỗi catalogue
    // (Rust `.parse::<i64>().map_err(|_| ())` cùng nghĩa).
    const createdAtMillis =
      typeof createdAt === 'number' ? createdAt : Number.parseInt(String(createdAt), 10);
    if (!Number.isSafeInteger(createdAtMillis)) {
      throw new CatalogueError();
    }
    return { id, createdAtMillis, sellerTenantId };
  });
}

/** Đọc ánh xạ `tenant id → tên tenant công khai` từ binding gateway. */
async function fetchTenantNames(env: LlmApiEnv): Promise<Map<string, string>> {
  const rows = await queryBinding(env, BINDING_GATEWAY, TENANT_NAMES_SQL);
  const tenants = new Map<string, string>();
  for (const row of rows) {
    const id = row.id;
    const name = row.name;
    if (typeof id !== 'string' || typeof name !== 'string') {
      throw new CatalogueError();
    }
    tenants.set(id, name);
  }
  return tenants;
}

/**
 * Lấy catalogue model đang phục vụ: offer `active` từ marketplace, owner ánh
 * xạ qua tenant gateway. Bất kỳ lỗi nào (binding thiếu, query lỗi, tenant
 * không ánh xạ được) đều ném `CatalogueError` — route quyết định fail-closed.
 * Catalogue rỗng là kết quả HỢP LỆ (200 `data: []`), không phải lỗi.
 */
export async function servingCatalogue(env: LlmApiEnv): Promise<ServingModel[]> {
  const offers = await fetchActiveOffers(env);
  if (offers.length === 0) {
    return [];
  }
  const tenants = await fetchTenantNames(env);
  return offers.map((offer) => {
    const ownedBy = tenants.get(offer.sellerTenantId);
    if (ownedBy === undefined) {
      throw new CatalogueError();
    }
    return {
      id: offer.id,
      // Rust: i64 division — truncate về 0 (millis epoch luôn dương trong thực tế).
      created: Math.trunc(offer.createdAtMillis / 1000),
      ownedBy,
    };
  });
}
