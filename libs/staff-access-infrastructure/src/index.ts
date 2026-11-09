/**
 * `@ecoma-io/staff-access-infrastructure` — PostgreSQL adapter của bounded
 * context `staff-access` qua Hyperdrive binding `DB_STAFF_ACCESS`.
 *
 * Mỗi module là một adapter của schema trong
 * `apps/staff-access/db/migrations/` — SQL là bản chép của schema, không có
 * hằng "tự chế" nào. Không có I/O nào ngoài postgres.js client; không có logic
 * authorization nào ở đây (catalog govern, backend enforce — A23/ADR-0009).
 */

export { StaffAccessConfigurationError } from './configuration-error';
export {
  createStaffAccessPostgresClient,
  isStaffAccessSchemaError,
  withStaffAccessClient,
  type StaffAccessClient,
  type StaffAccessClientConfig,
  type StaffAccessClientOptions,
  type StaffAccessHyperdriveBinding,
  type StaffAccessQueryable,
} from './postgres';
export {
  getStaffById,
  getStaffBySub,
  insertStaff,
  listStaff,
  type StaffRow,
} from './staff-repository';
export {
  getRoleById,
  listActiveRoles,
  listEffectivePermissionIdsForStaff,
  listRolePermissionIds,
  type RoleRow,
} from './role-repository';
export {
  getPermissionById,
  listActivePermissions,
  type PermissionRow,
} from './permission-repository';
export {
  getAssignmentById,
  insertAssignment,
  listAssignmentsForStaff,
  revokeAssignment,
  type AssignmentRow,
} from './assignment-repository';
export {
  appendAuditEntry,
  queryAuditEntries,
  type AppendAuditEntryInput,
  type AuditEntryRow,
  type AuditQueryFilters,
} from './audit-repository';
export {
  getEntitlement,
  listEntitlementsForStaff,
  settleOutboxEvent,
  upsertEntitlement,
  type EntitlementEvent,
  type EntitlementRow,
} from './entitlement-repository';
export type { StaffAccessTransaction } from './postgres';
