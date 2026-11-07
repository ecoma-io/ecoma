/**
 * `@ecoma-io/backoffice-domain` — value object, invariant vòng đời và constraint
 * thuần của bounded context `backoffice` (staff directory, permission catalog,
 * role, assignment, authorization audit) — A21
 * (`docs/architecture/01-architecture.md` §8).
 *
 * Thư viện này **không** import Nx project khác, **không** SQL, **không** Node
 * builtin và **không** I/O. Mọi tham số thời gian do caller truyền vào; domain
 * không đọc đồng hồ.
 *
 * ## Ràng buộc chưa chốt — không âm thầm chốt trong lib này
 *
 * Thiết kế của `backoffice` để mở **cố ý** các quyết định tại
 * `docs/domains/staff-access/domain-model.md` §9 (bootstrap first-admin,
 * revocation latency, custom role administration, step-up, internal contract,
 * retention audit). Domain lib này không có API nào chốt chúng:
 *
 * - **Không có policy runtime nào cấm self-assignment** ở đây: enforcement thuộc
 *   tầng application/resource-owning backend (SR-005, `01` §7). Domain chỉ là
 *   trục và vocabulary — test dưới đây ghim constraint type, không phải policy.
 * - **Không có permission cụ thể nào được phát minh ở đây** (A21: catalog chỉ
 *   định nghĩa `domain` × `action`; nội dung catalog là event governance).
 * - **Không có mechanism token/revocation nào ở đây** — A24 để mở.
 */

export {
  BACKOFFICE_STAFF_STATUSES,
  BACKOFFICE_STAFF_STATUS,
  isBackofficeStaffStatus,
  isTerminalStaffStatus,
  type BackofficeStaffStatus,
} from './staff-status';
export {
  BACKOFFICE_ACCOUNT_ID_ENTROPY_CHARS,
  BACKOFFICE_ACCOUNT_ID_PREFIX,
  createBackofficeAccountId,
  isBackofficeAccountId,
  backofficeAccountIdEntropy,
  type BackofficeAccountId,
} from './account-id';
export {
  REVOCATION_FRESHNESS_TTL_SECONDS,
  can,
  type AuthorizationDecision,
  type AuthorizationDenialReason,
  type AuthorizationMode,
  type AuthorizationRiskClass,
  type CatalogPermission,
  type GrantedAssignment,
} from './authorization-policy';
export {
  BACKOFFICE_DOMAIN_ERROR_MESSAGES,
  backofficeDomainError,
  isBackofficeDomainError,
  type BackofficeDomainError,
  type BackofficeDomainErrorCode,
} from './errors';
