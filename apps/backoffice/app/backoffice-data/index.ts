/**
 * Public API của lớp dữ liệu backoffice.
 *
 * App import lớp dữ liệu **qua barrel này**, không qua đường dẫn sâu:
 * `composables/use-backoffice-adapter.ts` lấy `createBackofficeAdapter` +
 * `resolveBackofficeDataMode` + kiểu `BackofficeDataAdapter`, `pages/staff.vue`
 * lấy kiểu `StaffStatus`. `data-gate.spec.ts` (colocated trong `app/backoffice-data/`) ghim đúng bề mặt đó: barrel
 * phải có consumer thật (không phải dead code) và các file app phải không tự đi
 * đường dẫn sâu.
 *
 * Vì vậy barrel cũng là chỗ liệt kê bề mặt công khai của module: một bypass (như
 * re-export mock factory) lộ ra ở đây và bị ghim lại.
 *
 * Ghi chú về gating (E1):
 * - Fixture (`PROTOTYPE_DATA`) KHÔNG còn được re-export khỏi barrel. Việc
 *   phơi bày dữ liệu mẫu ra ngoài API công khai đã bị đóng lại để tránh bypass.
 *   Mock adapter chỉ import fixture nội bộ (`mock-adapter.ts`).
 * - `createMockBackofficeAdapter` cũng KHÔNG được re-export: phơi factory trả
 *   thẳng mock adapter ở đây là một đường bypass khác — người gọi lấy được dữ
 *   liệu mẫu mà không đi qua `createBackofficeAdapter`, tức không qua gating.
 * - `createUnavailableBackofficeAdapter` vẫn được re-export ở dưới vì nó không
 *   đọc fixture và không trả về dữ liệu nào; đây không phải đường lấy dữ liệu,
 *   nên không cần gate.
 * - Lối vào duy nhất để có adapter **phục vụ dữ liệu** là
 *   `createBackofficeAdapter`; nó nhận chế độ đã phân giải từ
 *   `resolveBackofficeDataMode` (fail-closed).
 */
export { createBackofficeAdapter } from './adapter';
export {
  BACKOFFICE_BACKEND_UNAVAILABLE_CODE,
  BackofficeBackendUnavailableError,
  createUnavailableBackofficeAdapter,
} from './unavailable-adapter';
export {
  BACKOFFICE_DATA_MODE_DISABLED,
  BACKOFFICE_PREVIEW_DATA_MODE,
  BACKOFFICE_REALTIME_DATA_MODE,
  resolveBackofficeDataMode,
  type BackofficeDataMode,
} from './data-mode';
export type {
  AuditEntry,
  BackofficeDataAdapter,
  BackofficePrototypeData,
  Permission,
  StaffEntitlementSummary,
  StaffMember,
  StaffStatus,
  SystemRole,
} from './types';
