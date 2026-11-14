/**
 * Wire shapes cua portal surface tren control plane (issue #202) — APP-LOCAL.
 *
 * Nguon shape:
 * - R19 (`docs/applications/remote-cache/02-requirements.md`): list project,
 *   tao project, xem chi tiet project, tao them key (secret show-once), list
 *   metadata key khong lo secret, revoke key.
 * - R20: portal KHONG cap trusted CI cho developer credential trong M1 — moi
 *   key portal tao ra la developer credential (`trusted_ci = false`, chi
 *   scope `read`); write semantics cua trusted CI khong doi.
 * - Domain model §2.4: hai phan lop credential phan biet tuong minh o ca UI
 *   lan API — metadata wire mang `credential_class`, khong bao gio mang
 *   token hay hash.
 *
 * ⚠️ **Tam thoi app-local.** Contract public cho portal BFF (#180 tieu thu)
 * thuoc `libs/remote-cache-contracts` — vien di chuyen qua do cung vi pham
 * scope lock cua slice nay (issue #202 so huu libs); o day chi dinh nghia lai
 * dung shape do, va la CHO CHOT de hop dong khong troi: khi vien sang lib,
 * validator ben nay bo di, khong co ban cai dat thu hai.
 *
 * ⚠️ **Khong secret tren wire response.** Metadata key KHONG bao gio mang
 * `token`/`token_hash` — `FORBIDDEN_PORTAL_KEY_CREDENTIAL_FIELDS` la hang
 * phong thu thu hai sau shape TypeScript (pattern
 * `FORBIDDEN_PROJECT_CREDENTIAL_FIELDS` cua contract control plane).
 */

import type {
  RemoteCacheApiKeyScope,
  RemoteCacheControlPlaneValidation,
} from '@ecoma-io/remote-cache-contracts';

/** Request tao project qua portal — CHI mang `name`. */
export interface PortalCreateProjectRequest {
  readonly name: string;
}

/**
 * Request tao key them qua portal — HINH DONG: khong mang truong nao.
 * Scopes va phan lop credential khong phai lua chon cua caller: portal chi
 * cap developer credential (`PORTAL_API_KEY_SCOPES`, R20).
 */
export type PortalCreateApiKeyRequest = Record<string, never>;

/**
 * Scopes cua key portal cap — DOC-ONLY, tap dong. Portal khong cap `write`:
 * ghi cache la semantics cua trusted CI (R20; domain model §2.4).
 */
export const PORTAL_API_KEY_SCOPES: readonly RemoteCacheApiKeyScope[] = ['read'];

/** Phan lop credential tren wire — mirror domain model §2.4 (R20). */
export const PORTAL_CREDENTIAL_CLASSES = ['developer', 'trusted_ci'] as const;

/** Union phan lop credential tren wire. */
export type PortalCredentialClass = (typeof PORTAL_CREDENTIAL_CLASSES)[number];

/** Map cot `trusted_ci` cua schema sang phan lop tren wire. */
export function portalCredentialClassOf(trustedCi: boolean): PortalCredentialClass {
  return trustedCi ? 'trusted_ci' : 'developer';
}

/** Mot key metadata tren wire — KHONG BAO GIO mang token/hash. */
export interface PortalApiKeyMetadata {
  readonly id: string;
  readonly project_id: string;
  /** Chuoi scope hop le — key portal-cap luon la `read` (R20). */
  readonly scopes: readonly RemoteCacheApiKeyScope[];
  readonly credential_class: PortalCredentialClass;
  /** null = con hieu luc; revoke la state change, khong DELETE. */
  readonly revoked_at: string | null;
  readonly created_at: string;
}

/** Response tao key (show-once) — token gon CHI xuat hien o response nay. */
export interface PortalApiKeyCreated {
  readonly id: string;
  readonly scopes: readonly RemoteCacheApiKeyScope[];
  readonly credential_class: PortalCredentialClass;
  readonly token: string;
}

/** Response revoke key — khong mang secret. */
export interface PortalApiKeyRevoked {
  readonly id: string;
  readonly revoked_at: string;
}

/** Truong cam tren metadata/response key — secret va hash khong len day. */
export const FORBIDDEN_PORTAL_KEY_CREDENTIAL_FIELDS = [
  'token',
  'token_hash',
  'secret',
  'credential',
] as const;

/** Pattern UUID hinh thuc — cung pattern voi contract control plane. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Kiem tra timestamp ISO 8601 hinh thuc — cung quy tac voi contract control plane. */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (Number.isNaN(Date.parse(value))) return false;
  return /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value);
}

/**
 * Tap scope khong rong, khong lap, moi scope hop le — mirror contract machine.
 *
 * Chap nhan CA `read` lAN `write` la DUNG, khong he thung: validator nay xu
 * ly metadata doc tu DB, trong do key trusted CI tao qua duong may mang
 * `read write` (R20 — write la semantics cua trusted CI). Portal CHI CAP
 * `read` (`PORTAL_API_KEY_SCOPES`), nhung list metadata cua project phai hien
 * thay ca hai phan lop — nen validator hop le voi ca hai tap scope.
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
 * Validate request tao project qua portal — shape dong (chi `name`), ten dung
 * hinh. Bat ky truong nao khac (`trusted_ci`, `api_key_scopes`, ...) la tu
 * choi: portal khong nhan lua chon phan lop/scope tu caller (R20).
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

/** Pattern ten project — mirror CHECK `projects_name_check` / contract machine. */
const PROJECT_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/u;

/** Kiem ten project dung hinh — cung tap gia tri voi contract control plane. */
function isRemoteCacheProjectName(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_NAME_PATTERN.test(value);
}

/**
 * Validate request tao key them qua portal — phai la JSON object RONG. Caller
 * khong chon scopes hay phan lop: portal chi cap developer credential read-only
 * (R20); moi truong tren body la tu choi tường minh chu khong bo qua im lang.
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
 * Validate mot key metadata tren wire — shape dong, khong truong la, va tu
 * choi tung tu truong secret (`FORBIDDEN_PORTAL_KEY_CREDENTIAL_FIELDS`):
 * hang phong thu thu hai sau kieu TypeScript, cung pattern voi contract
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
      // Truong credential nam trong luat tu choi cung vong lap nay: khong co
      // nhanh thu hai sau no, nen message cu the cho secret/hash phai nam o
      // ngay cho tu choi duy nhat.
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
