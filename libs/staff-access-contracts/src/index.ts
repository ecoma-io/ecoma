/**
 * `@ecoma-io/staff-access-contracts` — hợp đồng thiết kế của bounded context
 * **Staff Access** (roadmap Phase 1, P1.2; issue #426): management API cho
 * staff/role/permission/assignment, authorization audit query, entitlement
 * read model và entitlement event.
 *
 * ⚠️ **Project này KHÔNG import implementation nào** — đúng ràng buộc
 * `type:contracts` của `.oxlintrc.json` (cấm `type:domain`/`type:application`/
 * `type:infrastructure` kể cả transitive). Contract là thứ provider **publish**
 * để consumer phụ thuộc vào, không phải một tầng đi theo chiều phụ thuộc.
 *
 * ⚠️ **Ranh giới entitlement ≠ authorization nằm trong wire shape.** Read
 * model và event entitlement chỉ mang **tính khả dụng sản phẩm**
 * (`FORBIDDEN_ENTITLEMENT_FIELDS` / `FORBIDDEN_ENTITLEMENT_EVENT_FIELDS` chặn
 * verdict/permission/role); KHÔNG có internal authorization-result contract —
 * [ADR-0009](../../docs/domains/staff-access/adr/0009-no-internal-authorization-result-contract.md).
 * P1.3 ghim phía docs của cùng ranh giới này.
 *
 * ⚠️ **Không pin các quyết định còn mở:** tập nhãn staff status là đề xuất
 * (`management-staff-contract.ts`, §4.2); nội dung system-defined role không
 * được khai ở đây (§4.4, ADR-0004); cơ chế delivery ≤5s của Phase 2 không được
 * mã hoá (ADR-0002; envelope event có `revision` cho idempotency nhưng KHÔNG
 * có transport).
 */

export {
  ASSIGNMENT_LIST_DEFAULT_LIMIT,
  ASSIGNMENT_LIST_MAX_LIMIT,
  assignmentListResponse,
  validateAssignmentListResponse,
  validateCreateAssignmentRequest,
  validateRevokeAssignmentRequest,
  validateStaffRoleAssignment,
  type AssignmentContractRejectionReason,
  type AssignmentContractValidation,
  type AssignmentListResponse,
  type AssignmentListValidation,
  type AssignmentScope,
  type CreateAssignmentRequest,
  type CreateAssignmentValidation,
  type RevokeAssignmentRequest,
  type RevokeAssignmentValidation,
  type StaffRoleAssignment,
} from './management-assignment-contract';
export {
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  AUDIT_OUTCOMES,
  auditListResponse,
  isAuditOutcome,
  FORBIDDEN_AUDIT_CONTEXT_KEYS,
  FORBIDDEN_AUDIT_FIELDS,
  validateAuditEntry,
  validateAuditListResponse,
  validateAuditQueryRequest,
  type AuditContractRejectionReason,
  type AuditContractValidation,
  type AuditEntry,
  type AuditListResponse,
  type AuditListValidation,
  type AuditOutcome,
  type AuditQueryRequest,
  type AuditQueryValidation,
} from './management-audit-contract';
export {
  ENTITLEMENT_DELIVERY_DEADLINE_MS,
  ENTITLEMENT_DELIVERY_EVENT_CLASSES,
  ENTITLEMENT_DELIVERY_LATENCY_METRIC,
  ENTITLEMENT_DELIVERY_METRIC_LABELS,
  ENTITLEMENT_FRESHNESS_CHECKS_TOTAL_METRIC,
  ENTITLEMENT_FRESHNESS_FAIL_CLOSED_TOTAL_METRIC,
  ENTITLEMENT_RECONCILIATION_STALE_PUBLISHED_TOTAL_METRIC,
  isEntitlementDeliveryEventClass,
  type EntitlementDeliveryEventClass,
  type EntitlementDeliveryMetricDimensions,
} from './entitlement-delivery-metrics-contract';
export {
  ENTITLEMENT_PRODUCTS,
  ENTITLEMENT_READ_MAX_PAGE,
  ENTITLEMENT_MAX_REVISION,
  ENTITLEMENT_STATUSES,
  entitlementReadResponse,
  isEntitlementProduct,
  isEntitlementStatus,
  FORBIDDEN_ENTITLEMENT_FIELDS,
  pickRevisionWinner,
  validateEntitlementEntry,
  validateEntitlementReadResponse,
  type EntitlementEntryValidation,
  type EntitlementListValidation,
  type EntitlementProduct,
  type EntitlementReadRejectionReason,
  type EntitlementReadResponse,
  type EntitlementReadValidation,
  type EntitlementStatus,
  type StaffEntitlementEntry,
} from './entitlement-read-contract';
export {
  shouldApplyEntitlementEvent,
  type EntitlementEventDecision,
  type EntitlementEventDecisionReason,
} from './entitlement-event-consumer';
export {
  ENTITLEMENT_EVENT_PRODUCER,
  ENTITLEMENT_EVENT_TYPES,
  entitlementEvent,
  FORBIDDEN_ENTITLEMENT_EVENT_FIELDS,
  isEntitlementEventType,
  validateEntitlementEvent,
  type EntitlementEvent,
  type EntitlementEventEntryValidation,
  type EntitlementEventRejectionReason,
  type EntitlementEventType,
  type EntitlementEventValidation,
} from './entitlement-events-contract';
export {
  FORBIDDEN_STAFF_PROFILE_FIELDS,
  isStaffStatus,
  isStaffSubFormat,
  STAFF_DISPLAY_NAME_MAX_LENGTH,
  STAFF_LIST_DEFAULT_LIMIT,
  STAFF_LIST_MAX_LIMIT,
  STAFF_STATUSES,
  staffListResponse,
  validateStaffListRequest,
  validateStaffListResponse,
  validateStaffMember,
  type StaffContractRejectionReason,
  type StaffContractValidation,
  type StaffListResponse,
  type StaffListValidation,
  type StaffMember,
  type StaffStatus,
} from './management-staff-contract';
export {
  FORBIDDEN_ROLE_FIELDS,
  isRoleKind,
  isRoleStatus,
  ROLE_KINDS,
  ROLE_LIST_MAX_LIMIT,
  ROLE_LIST_DEFAULT_LIMIT,
  ROLE_STATUSES,
  roleListResponse,
  validateRoleListResponse,
  validateStaffRole,
  type RoleContractRejectionReason,
  type RoleContractValidation,
  type RoleEntryValidation,
  type RoleKind,
  type RoleListResponse,
  type RoleListValidation,
  type RoleStatus,
  type StaffRole,
} from './management-role-contract';
export {
  FORBIDDEN_PERMISSION_FIELDS,
  isPermissionIdFormat,
  isPermissionStatus,
  PERMISSION_LIST_DEFAULT_LIMIT,
  PERMISSION_LIST_MAX_LIMIT,
  PERMISSION_STATUSES,
  permissionEntry,
  permissionListResponse,
  validatePermission,
  validatePermissionListResponse,
  type Permission,
  type PermissionContractRejectionReason,
  type PermissionContractValidation,
  type PermissionEntryValidation,
  type PermissionListResponse,
  type PermissionListValidation,
  type PermissionStatus,
} from './management-permission-contract';
