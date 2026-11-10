/**
 * `@ecoma-io/tenant-kernel-domain` — kernel dùng chung, mỏng, của bounded
 * context tenant. Tầng domain thuần: không import dự án Nx nào, không SQL,
 * không Node builtin, không I/O, không đồng hồ, không số ngẫu nhiên, không
 * biến môi trường; mọi định danh và giá trị thời gian do caller truyền vào.
 *
 * Kernel **không** định nghĩa: định danh thành viên, incarnation, status, bản
 * revoke, timestamp tạo/xoá, vòng đời, vai trò, permission, grant, kế hoạch hay
 * quota. Mọi giá trị công khai là chuỗi opaque; mỗi bounded context giữ kiểu
 * branded của riêng mình và không bắt consumer áp dụng toàn bộ primitive.
 *
 * Một điểm vào công khai duy nhất: `exports` chỉ có `"."`, không có subpath exports.
 */

export { MAX_OPAQUE_ID_LENGTH, isOpaqueId } from './opaque-id';
export { isEpochMillis } from './epoch-millis';
export { type OwnedTenant, isOwnedTenant } from './tenant';
export { isTenantOwnedBy } from './tenant';
export { type TenantMembershipRef, isTenantMembershipRef } from './membership-ref';
export { ensureTenantScopedMembershipRefs } from './membership-ref';
