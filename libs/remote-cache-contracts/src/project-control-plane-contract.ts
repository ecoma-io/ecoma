/**
 * Wire contract cho **control plane** của bounded context `remote-cache`
 * (P4.1 skeleton; issue #442, ADR-0015).
 *
 * Ranh giới nguồn (docs/domains/remote-cache/):
 * - ADR-0015: control plane sở hữu tenant/project/membership/API key;
 *   skeleton P4.1 chỉ mở `POST /projects` và `GET /projects` trong phạm vi
 *   tenant của key — KHÔNG có data plane, KHÔNG có quota, KHÔNG có hardening
 *   (P4.2/P4.3/P4.4).
 * - `02-requirements.md` R2: API key project-scoped có phân quyền read/write;
 *   key tenant-level chỉ quản lý project trong tenant đó.
 *
 * ⚠️ **Đây là contract (shape wire), không phải API HTTP.** URL và method
 * thực tế thuộc implement; contract này ghim **trường nào đi qua dây** và
 * **ràng buộc hình thức** của chúng.
 *
 * ⚠️ **Self-contained — KHÔNG import `@ecoma-io/remote-cache-domain`.**
 * Constraint `type:contracts` cấm phụ thuộc `type:domain` kể cả qua trung
 * gian: contract là thứ provider **publish** cho consumer phụ thuộc, không
 * phải một tầng đi theo chiều phụ thuộc. Vocabulary scope/status được khai
 * lại tại đây ở mức **hình thức wire**; chữ ký nghiệp vụ đầy đủ (type guard
 * riêng cho từng trạng thái vòng đời, catalog lỗi domain) thuộc domain lib —
 * nếu hai tập trôi nhau, test contract so le là chốt chặn.
 *
 * ⚠️ **Không có secret trên wire response.** Token API key chỉ trả một lần
 * lúc tạo (show-once); response list/get project KHÔNG bao giờ mang token
 * hoặc hash của token — `FORBIDDEN_PROJECT_CREDENTIAL_FIELDS` là hàng phòng
 * thủ thứ hai sau shape TypeScript.
 */

/** Tap scope hop le cua mot API key tren wire — mirror DB CHECK
 * (`remote_cache.machine_tokens.scopes`); tap dong nhat voi
 * `REMOTE_CACHE_API_KEY_SCOPES` cua domain lib, lech tap la bug contract. */
export const REMOTE_CACHE_API_KEY_SCOPES = ['read', 'write'] as const;

/** Union scope tren wire. */
export type RemoteCacheApiKeyScope = (typeof REMOTE_CACHE_API_KEY_SCOPES)[number];

/** Type guard scope tren wire. */
export function isRemoteCacheApiKeyScope(value: unknown): value is RemoteCacheApiKeyScope {
  return (
    typeof value === 'string' && (REMOTE_CACHE_API_KEY_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * Tap status tenant tren wire — mirror CHECK `tenant_status_check` cua
 * migration control plane; dong nhat voi `REMOTE_CACHE_TENANT_STATUSES` cua
 * domain lib.
 */
export const REMOTE_CACHE_TENANT_STATUSES = ['active', 'suspended', 'deleted'] as const;

/** Union status tenant tren wire. */
export type RemoteCacheTenantStatus = (typeof REMOTE_CACHE_TENANT_STATUSES)[number];

/** Type guard status tenant tren wire. */
export function isRemoteCacheTenantStatus(value: unknown): value is RemoteCacheTenantStatus {
  return (
    typeof value === 'string' && (REMOTE_CACHE_TENANT_STATUSES as readonly string[]).includes(value)
  );
}

/** Nguyên tắc forbidden của wire: project không bao giờ mang secret. */
export const FORBIDDEN_PROJECT_CREDENTIAL_FIELDS = [
  'token',
  'api_key',
  'token_hash',
  'secret',
  'credential',
] as const;

/** Một project trên wire — con của tenant, không mang credential nào. */
export interface RemoteCacheProject {
  /** UUID của project — do control plane sinh. */
  readonly id: string;
  /** UUID tenant sở hữu project. */
  readonly tenant_id: string;
  /**
   * Tên project duy nhất trong tenant — pattern DNS-like chữ thường
   * (`REMOTE_CACHE_PROJECT_NAME_PATTERN`); dùng làm tên cache/namespace ở
   * data plane (P4.2).
   */
  readonly name: string;
  readonly created_at: string;
}

/** Pattern tên project — mirror CHECK của migration control plane. */
export const REMOTE_CACHE_PROJECT_NAME_PATTERN = '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$' as const;

/** Kiểm tên project có đúng hình không — validator và route dùng chung. */
export function isRemoteCacheProjectName(value: unknown): value is string {
  return (
    typeof value === 'string' && new RegExp(REMOTE_CACHE_PROJECT_NAME_PATTERN, 'u').test(value)
  );
}

/** Lý do từ chối một payload control plane (request hay response). */
export type RemoteCacheControlPlaneRejectionReason =
  | 'invalid_payload'
  | 'invalid_entry'
  | 'forbidden_field'
  | 'invalid_tenant_id'
  | 'invalid_project_name'
  | 'invalid_scopes'
  | 'oversized_page'
  | 'invalid_pagination';

/** Kết quả validate — discriminated union, cùng hình với các contracts khác. */
export type RemoteCacheControlPlaneValidation<T> =
  | { readonly ok: true; readonly payload: T }
  | {
      readonly ok: false;
      readonly reason: RemoteCacheControlPlaneRejectionReason;
      readonly detail: string;
    };

/** Pattern UUID hình thức — chặn chuỗi rỗng/kỳ dị, không kiểm tra variant. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Kiểm tra timestamp ISO 8601 hình thức (parse được, có múi giờ rõ). */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (Number.isNaN(Date.parse(value))) return false;
  return /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value);
}

/**
 * Request tạo project trong tenant của key gọi — skeleton P4.1.
 *
 * `tenant_id` đến từ context xác thực của API key (không từ body); body chỉ
 * mang `name` và `api_key_scopes` của key sẽ tạo kèm project. Skeleton không
 * mở endpoint tạo key riêng (P4.2).
 */
export interface CreateRemoteCacheProjectRequest {
  readonly name: string;
  /** Scopes của key mặc định tạo kèm project — không rỗng, không lặp. */
  readonly api_key_scopes: readonly RemoteCacheApiKeyScope[];
  /**
   * true nếu key mặc định là credential CI tin cậy (được phép ghi nếu có scope
   * `write`). false = key không tin cậy (fork/PR) — chỉ được đọc, không bao giờ
   * được ghi (P4.4 fork/PR write protection). Mac định false.
   */
  readonly trusted_ci?: boolean;
}

const CREATE_REQUEST_KEYS = ['name', 'api_key_scopes'] as const;

/**
 * Validate request tạo project — shape đóng (không trường lạ), tên đúng hình,
 * scopes không rỗng không lặp, trusted_ci (nếu có) phải là boolean.
 */
export function validateCreateRemoteCacheProjectRequest(
  value: unknown,
): RemoteCacheControlPlaneValidation<CreateRemoteCacheProjectRequest> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: 'Create-project request must be an object.',
    };
  }
  const record = value as Record<string, unknown>;

  const keys = Object.keys(record);
  for (const key of CREATE_REQUEST_KEYS) {
    if (!keys.includes(key) || record[key] === undefined) {
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `Create-project request is missing required field: ${key}.`,
      };
    }
  }
  for (const key of keys) {
    if (!(CREATE_REQUEST_KEYS as readonly string[]).includes(key) && key !== 'trusted_ci') {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Create-project request carries a field outside the contract: ${key}.`,
      };
    }
  }

  if (!isRemoteCacheProjectName(record.name)) {
    return {
      ok: false,
      reason: 'invalid_project_name',
      detail: 'name must match ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$ (lowercase DNS-like label).',
    };
  }
  if (
    !Array.isArray(record.api_key_scopes) ||
    record.api_key_scopes.length === 0 ||
    !record.api_key_scopes.every(isRemoteCacheApiKeyScope) ||
    new Set(record.api_key_scopes).size !== record.api_key_scopes.length
  ) {
    return {
      ok: false,
      reason: 'invalid_scopes',
      detail: 'api_key_scopes must be a non-empty, duplicate-free array of "read"/"write".',
    };
  }

  if (record.trusted_ci !== undefined && typeof record.trusted_ci !== 'boolean') {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: 'trusted_ci must be a boolean if present.',
    };
  }

  return {
    ok: true,
    payload: {
      name: record.name,
      api_key_scopes: [...record.api_key_scopes] as RemoteCacheApiKeyScope[],
      trusted_ci: record.trusted_ci ?? false,
    },
  };
}

/**
 * Validate một bản ghi project trên wire — chặn forbidden credential fields
 * trước, rồi kiểm shape từng trường. Không nối **giá trị** trường bị cấm vào
 * `detail`; chỉ nêu tên trường.
 */
export function validateRemoteCacheProject(
  value: unknown,
): RemoteCacheControlPlaneValidation<RemoteCacheProject> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Project entry must be an object.' };
  }
  const record = value as Record<string, unknown>;

  for (const field of FORBIDDEN_PROJECT_CREDENTIAL_FIELDS) {
    if (field in record) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Project entry carries a forbidden credential field: ${field}.`,
      };
    }
  }

  const requiredKeys = ['id', 'tenant_id', 'name', 'created_at'];
  const keys = Object.keys(record);
  for (const key of requiredKeys) {
    // `undefined` cũng là thiếu: object literal trong caller có thể mang key
    // mà không có giá trị, và contract phải báo "missing" chứ không nhảy
    // xuống kiểm tra hình thật của field đó.
    if (!keys.includes(key) || record[key] === undefined) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: `Project entry is missing required field: ${key}.`,
      };
    }
  }
  for (const key of keys) {
    if (!requiredKeys.includes(key)) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Project entry carries a field outside the contract: ${key}.`,
      };
    }
  }

  if (!isUuid(record.id)) {
    return { ok: false, reason: 'invalid_entry', detail: 'id must be a UUID string.' };
  }
  if (!isUuid(record.tenant_id)) {
    return { ok: false, reason: 'invalid_tenant_id', detail: 'tenant_id must be a UUID string.' };
  }
  if (!isRemoteCacheProjectName(record.name)) {
    return {
      ok: false,
      reason: 'invalid_project_name',
      detail: 'name must match ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$ (lowercase DNS-like label).',
    };
  }
  if (!isIsoTimestamp(record.created_at)) {
    return {
      ok: false,
      reason: 'invalid_entry',
      detail: 'created_at must be an ISO 8601 timestamp with an explicit offset or Z.',
    };
  }

  return {
    ok: true,
    payload: {
      id: record.id,
      tenant_id: record.tenant_id,
      name: record.name,
      created_at: record.created_at,
    },
  };
}

/** Trần số bản ghi một trang list project — không có listing không giới hạn. */
export const PROJECT_LIST_MAX_LIMIT = 100;

/** Giá trị `limit` mặc định khi caller không truyền. */
export const PROJECT_LIST_DEFAULT_LIMIT = 50;

/** Response list project của tenant — một trang có cursor. */
export interface RemoteCacheProjectListResponse {
  readonly projects: readonly RemoteCacheProject[];
  /**
   * Cursor lấy trang tiếp theo — `null` là hết dữ liệu. Không trả tổng số
   * bản ghi: consumer không dùng contract list để đếm project.
   */
  readonly next_cursor: string | null;
}

/**
 * Validate response list project — chặn trần trang trước từng entry:
 * response vượt trần là server phá contract, consumer không tin cả trang.
 */
export function validateRemoteCacheProjectListResponse(
  payload: unknown,
): RemoteCacheControlPlaneValidation<RemoteCacheProjectListResponse> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Response must be an object.' };
  }
  const record = payload as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== 'projects' && key !== 'next_cursor') {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Response contains a field outside the contract: ${key}.`,
      };
    }
  }
  if (!Array.isArray(record.projects)) {
    return { ok: false, reason: 'invalid_payload', detail: 'projects must be an array.' };
  }
  if (record.projects.length > PROJECT_LIST_MAX_LIMIT) {
    return {
      ok: false,
      reason: 'oversized_page',
      detail: `projects page exceeds the ceiling of ${PROJECT_LIST_MAX_LIMIT} entries.`,
    };
  }
  if (
    record.next_cursor !== null &&
    (typeof record.next_cursor !== 'string' || record.next_cursor.length === 0)
  ) {
    return {
      ok: false,
      reason: 'invalid_pagination',
      detail: 'next_cursor must be null or a non-empty string.',
    };
  }

  const projects: RemoteCacheProject[] = [];
  for (const entry of record.projects) {
    const result = validateRemoteCacheProject(entry);
    if (!result.ok) {
      return result;
    }
    projects.push(result.payload);
  }

  return {
    ok: true,
    payload: { projects, next_cursor: record.next_cursor as string | null },
  };
}

/**
 * Validate tham số phân trang request list — `limit` trong [1, MAX],
 * `cursor` chuỗi rỗng hoặc vắng là trang đầu.
 */
export function validateRemoteCacheProjectListRequest(params: {
  readonly limit?: unknown;
  readonly cursor?: unknown;
}): RemoteCacheControlPlaneValidation<{
  readonly limit: number;
  readonly cursor: string | null;
}> {
  const { limit, cursor } = params;
  if (
    limit !== undefined &&
    (typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > PROJECT_LIST_MAX_LIMIT)
  ) {
    return {
      ok: false,
      reason: 'invalid_pagination',
      detail: `limit must be an integer in [1, ${PROJECT_LIST_MAX_LIMIT}].`,
    };
  }
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    return {
      ok: false,
      reason: 'invalid_pagination',
      detail: 'cursor must be an empty string, null, or a non-empty cursor token.',
    };
  }
  return {
    ok: true,
    payload: {
      limit: limit === undefined ? PROJECT_LIST_DEFAULT_LIMIT : limit,
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    },
  };
}
