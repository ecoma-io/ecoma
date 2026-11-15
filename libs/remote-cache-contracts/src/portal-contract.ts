/**
 * Wire contract cho **portal surface** của control plane bounded context
 * `remote-cache` (issue #202 — hiện thực đã merge PR #226; issue #180 tiêu thụ).
 *
 * Nguồn shape: `apps/remote-cache-api/src/portal-contract.ts` (bản app-local
 * trước khi viênb sang lib) — contract này ghim **đúng** shape đó ở mức wire;
 * việc app consume từ đây (thay vì giữ bản riêng) là follow-up thuộc app.
 *
 * Ranh giới nguồn (docs/domains/remote-cache/):
 * - R19 (`docs/applications/remote-cache/02-requirements.md`): list project,
 *   tạo project, xem chi tiết project, tạo thêm key (secret show-once), list
 *   metadata key không lộ secret, revoke key.
 * - R20: portal KHÔNG cấp trusted CI cho developer credential trong M1 — mọi
 *   key portal tạo ra là developer credential (`trusted_ci = false`, chỉ scope
 *   `read`); write semantics của trusted CI không đổi.
 * - Domain model §2.4: hai phần lớp credential phân biệt tường minh ở cả UI
 *   lẫn API — metadata wire mang `credential_class`, không bao giờ mang token
 *   hay hash.
 *
 * ⚠️ **Self-contained — KHÔNG import implementation nào** (cùng ràng buộc
 * `type:contracts` với `project-control-plane-contract.ts`). Vocabulary
 * scope/class tái dùng đúng union đã export từ contract control plane.
 *
 * ⚠️ **Không secret trên wire response.** Metadata key KHÔNG bao giờ mang
 * `token`/`token_hash` — token gon chỉ xuất hiện ở response của hai route tạo
 * (show-once); `FORBIDDEN_PORTAL_KEY_CREDENTIAL_FIELDS` là hàng phòng thủ thứ
 * hai sau shape TypeScript.
 */

import type {
  RemoteCacheApiKeyScope,
  RemoteCacheControlPlaneValidation,
} from './project-control-plane-contract';

// Re-export đúng hình dạng validate trả về — consumer của contract portal
// (spec này, BFF #180) narrow outcome qua hai type đó, nên chúng thuộc bề mặt
// export của module, không chỉ là import nội bộ.
export type {
  RemoteCacheControlPlaneRejectionReason,
  RemoteCacheControlPlaneValidation,
} from './project-control-plane-contract';

/** Request tạo project qua portal — CHỈ mang `name`. */
export interface PortalCreateProjectRequest {
  readonly name: string;
}

/**
 * Request tạo key thêm qua portal — HÌNH ĐỘNG: không mang trường nào.
 * Scopes và phần lớp credential không phải lựa chọn của caller: portal chỉ
 * cấp developer credential (`PORTAL_API_KEY_SCOPES`, R20).
 */
export type PortalCreateApiKeyRequest = Record<string, never>;

/**
 * Scopes của key portal cấp — DOC-ONLY, tập đóng. Portal không cấp `write`:
 * ghi cache là semantics của trusted CI (R20; domain model §2.4).
 */
export const PORTAL_API_KEY_SCOPES: readonly RemoteCacheApiKeyScope[] = ['read'];

/** Phần lớp credential trên wire — mirror domain model §2.4 (R20). */
export const PORTAL_CREDENTIAL_CLASSES = ['developer', 'trusted_ci'] as const;

/** Union phần lớp credential trên wire. */
export type PortalCredentialClass = (typeof PORTAL_CREDENTIAL_CLASSES)[number];

/** Map cột `trusted_ci` của schema sang phần lớp trên wire. */
export function portalCredentialClassOf(trustedCi: boolean): PortalCredentialClass {
  return trustedCi ? 'trusted_ci' : 'developer';
}

/** Một key metadata trên wire — KHÔNG BAO GIỜ mang token/hash. */
export interface PortalApiKeyMetadata {
  readonly id: string;
  readonly project_id: string;
  /** Chuỗi scope hợp lệ — key portal-cấp luôn là `read` (R20). */
  readonly scopes: readonly RemoteCacheApiKeyScope[];
  readonly credential_class: PortalCredentialClass;
  /** null = còn hiệu lực; revoke là state change, không DELETE. */
  readonly revoked_at: string | null;
  readonly created_at: string;
}

/** Response tạo key (show-once) — token gọn CHỈ xuất hiện ở response này. */
export interface PortalApiKeyCreated {
  readonly id: string;
  readonly scopes: readonly RemoteCacheApiKeyScope[];
  readonly credential_class: PortalCredentialClass;
  readonly token: string;
}

/** Response revoke key — không mang secret. */
export interface PortalApiKeyRevoked {
  readonly id: string;
  readonly revoked_at: string;
}

/** Trường cấm trên metadata/response key — secret và hash không lên đây. */
export const FORBIDDEN_PORTAL_KEY_CREDENTIAL_FIELDS = [
  'token',
  'token_hash',
  'secret',
  'credential',
] as const;

/** Pattern tên project — mirror CHECK `projects_name_check` / contract machine. */
const PROJECT_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/u;

/** Kiểm tên project đúng hình — cùng tập giá trị với contract control plane. */
function isRemoteCacheProjectName(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_NAME_PATTERN.test(value);
}

/** Pattern UUID hình thức — cùng pattern với contract control plane. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Kiểm tra timestamp ISO 8601 hình thức — cùng quy tắc với contract control plane. */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (Number.isNaN(Date.parse(value))) return false;
  return /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value);
}

/**
 * Tập scope không rỗng, không lặp, mỗi scope hợp lệ — mirror contract machine.
 *
 * Chấp nhận cả `read` lẫn `write` là ĐÚNG, không phải sơ suất: validator này
 * xử lý metadata đọc từ DB, trong đó key trusted CI tạo qua đường máy mang
 * `read write` (R20 — write là semantics của trusted CI). Portal CHỈ CẤP
 * `read` (`PORTAL_API_KEY_SCOPES`), nhưng list metadata của project phải hiện
 * thấy cả hai phần lớp — nên validator hợp lệ với cả hai tập scope.
 */
function isValidScopeList(value: unknown): value is readonly RemoteCacheApiKeyScope[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((scope) => typeof scope === 'string' && (scope === 'read' || scope === 'write')) &&
    new Set(value).size === value.length
  );
}

/**
 * Validate request tạo project qua portal — shape đóng (chỉ `name`), tên đúng
 * hình. Bất kỳ trường nào khác (`trusted_ci`, `api_key_scopes`, ...) là từ
 * chối: portal không nhận lựa chọn phần lớp/scope từ caller (R20).
 */
export function validatePortalCreateProjectRequest(
  value: unknown,
): RemoteCacheControlPlaneValidation<PortalCreateProjectRequest> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: 'Create-project request must be a JSON object.',
    };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.includes('name') || record['name'] === undefined) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: 'Create-project request is missing required field: name.',
    };
  }
  if (keys.some((key) => key !== 'name')) {
    return {
      ok: false,
      reason: 'forbidden_field',
      detail:
        'Create-project request carries a field outside the portal contract; the portal mints developer credentials only (read scope, never trusted CI).',
    };
  }
  if (!isRemoteCacheProjectName(record['name'])) {
    return {
      ok: false,
      reason: 'invalid_project_name',
      detail: 'name must match ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$ (lowercase DNS-like label).',
    };
  }
  return { ok: true, payload: { name: record['name'] as string } };
}

/**
 * Validate request tạo key thêm qua portal — phải là JSON object RỖNG. Caller
 * không chọn scopes hay phần lớp: portal chỉ cấp developer credential read-only
 * (R20); mọi trường trên body là từ chối tường minh chứ không bỏ qua im lặng.
 */
export function validatePortalCreateApiKeyRequest(
  value: unknown,
): RemoteCacheControlPlaneValidation<PortalCreateApiKeyRequest> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: 'Create-key request must be a JSON object.',
    };
  }
  if (Object.keys(value as Record<string, unknown>).length !== 0) {
    return {
      ok: false,
      reason: 'forbidden_field',
      detail:
        'Create-key request takes no fields; the portal mints developer credentials with a fixed read scope (never trusted CI).',
    };
  }
  return { ok: true, payload: {} };
}

/**
 * Validate một key metadata trên wire — shape đóng, không trường lạ, và từ
 * chối từng trường secret (`FORBIDDEN_PORTAL_KEY_CREDENTIAL_FIELDS`):
 * hàng phòng thủ thứ hai sau kiểu TypeScript, cùng pattern với contract
 * control plane.
 */
export function validatePortalApiKeyMetadata(
  value: unknown,
): RemoteCacheControlPlaneValidation<PortalApiKeyMetadata> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: 'API key metadata must be an object.',
    };
  }
  const record = value as Record<string, unknown>;
  const requiredKeys = [
    'id',
    'project_id',
    'scopes',
    'credential_class',
    'revoked_at',
    'created_at',
  ] as const;
  for (const key of requiredKeys) {
    if (!Object.keys(record).includes(key) || record[key] === undefined) {
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `API key metadata is missing required field: ${key}.`,
      };
    }
  }
  for (const key of Object.keys(record)) {
    if (!(requiredKeys as readonly string[]).includes(key)) {
      // Trường credential nằm trong luật từ chối cùng vòng lặp này: không có
      // nhánh thứ hai sau nó, nên message cụ thể cho secret/hash phải nằm ở
      // ngay chỗ từ chối duy nhất.
      const isCredential = (FORBIDDEN_PORTAL_KEY_CREDENTIAL_FIELDS as readonly string[]).includes(
        key,
      );
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: isCredential
          ? 'API key metadata must never carry a credential secret or hash.'
          : `API key metadata carries a field outside the contract: ${key}.`,
      };
    }
  }
  if (!isUuid(record['id'])) {
    return { ok: false, reason: 'invalid_payload', detail: 'id must be a UUID.' };
  }
  if (!isUuid(record['project_id'])) {
    return { ok: false, reason: 'invalid_payload', detail: 'project_id must be a UUID.' };
  }
  if (!isValidScopeList(record['scopes'])) {
    return {
      ok: false,
      reason: 'invalid_scopes',
      detail: 'scopes must be a non-empty set of read/write.',
    };
  }
  if (
    typeof record['credential_class'] !== 'string' ||
    !(PORTAL_CREDENTIAL_CLASSES as readonly string[]).includes(record['credential_class'])
  ) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: `credential_class must be one of ${PORTAL_CREDENTIAL_CLASSES.join(', ')}.`,
    };
  }
  if (record['revoked_at'] !== null && !isIsoTimestamp(record['revoked_at'])) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: 'revoked_at must be null or an ISO timestamp.',
    };
  }
  if (!isIsoTimestamp(record['created_at'])) {
    return { ok: false, reason: 'invalid_payload', detail: 'created_at must be an ISO timestamp.' };
  }
  return {
    ok: true,
    payload: {
      id: record['id'] as string,
      project_id: record['project_id'] as string,
      scopes: record['scopes'] as readonly RemoteCacheApiKeyScope[],
      credential_class: record['credential_class'] as PortalCredentialClass,
      revoked_at: record['revoked_at'] as string | null,
      created_at: record['created_at'] as string,
    },
  };
}
