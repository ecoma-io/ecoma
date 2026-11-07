import type {
  AuditEntry,
  BackofficeDataAdapter,
  BackofficePrototypeData,
  Permission,
  StaffEntitlementSummary,
  StaffMember,
  SystemRole,
} from './types';
import { PROTOTYPE_DATA } from './prototype-fixture';

/**
 * Adapter mock — dữ liệu **cục bộ, tất định** để dựng và kiểm UI trước khi
 * hợp đồng thật có mặt.
 *
 * Ba tính chất phải giữ:
 *
 * 1. **Không giả vờ là server.** Mọi thứ nó trả về chỉ nằm trong bộ nhớ.
 *    `isPreview = true` và banner "dữ liệu mẫu"
 *    (`BackofficeSampleNotice`) phải luôn đi cùng khi sử dụng adapter này.
 * 2. **Tất định.** Không dùng `Date.now()`, không sinh ngẫu nhiên. Mọi thứ đều
 *    đọc từ fixture đã frozen. SSR và client luôn nhận cùng dữ liệu.
 * 3. **Thay thế được bằng một dòng.** Factory dưới đây là điểm duy nhất chọn
 *    implementation; đổi sang adapter thật chỉ đổi chỗ này. Không có `fetch`,
 *    không có `useFetch`, không có truy cập storage — không bao giờ gọi endpoint
 *    thật dưới dạng mock.
 *
 * ⚠️ **Chỉ đọc.** Adapter thật sẽ có thao tác ghi, nhưng chúng chỉ được thêm
 * cùng contract và enforcement server-side — xem ghi chú ở
 * `BackofficeDataAdapter` trong `types.ts`.
 */
export function createMockBackofficeAdapter(
  data: BackofficePrototypeData = PROTOTYPE_DATA,
): BackofficeDataAdapter {
  // Shallow copy nội bộ để không làm ảnh hưởng fixture gốc.
  const state = {
    staff: [...data.staff],
    roles: [...data.roles],
    permissions: [...data.permissions],
  };

  return {
    isPreview: true,

    async listStaff(): Promise<readonly StaffMember[]> {
      return state.staff;
    },

    async listRoles(): Promise<readonly SystemRole[]> {
      return state.roles;
    },

    async listPermissions(): Promise<readonly Permission[]> {
      return state.permissions;
    },

    async listEntitlements(_staffId: string): Promise<readonly StaffEntitlementSummary[]> {
      // Prototype chưa đồng bộ entitlement từ Staff Access: trả tập rỗng,
      // không phải dữ liệu mẫu bịa. UI hiển thị "không có entitlement" cho
      // mọi staff khi chạy chế độ prototype.
      return [];
    },

    async listAuditEntries(_query: Record<string, string>): Promise<readonly AuditEntry[]> {
      // Prototype không đồng bộ bản ghi audit từ Staff Access: trả tập rỗng.
      return [];
    },
  };
}
