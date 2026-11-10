import { isOpaqueId } from './opaque-id';

/**
 * Tham chiếu thành viên trong phạm vi một tenant: định danh tenant và định
 * danh actor, cả hai là chuỗi opaque đã verify. Kernel không định nghĩa định
 * danh thành viên, incarnation, status hay bản revoke — các concept đó chưa
 * nằm trong kernel.
 */

/** Tham chiếu một thành viên trong một tenant. */
export interface TenantMembershipRef {
  readonly tenantId: string;
  readonly actor: string;
}

/**
 * Kiểm tra đối tượng có phải tham chiếu thành viên hợp lệ: `tenantId` và
 * `actor` đều qua isOpaqueId. Không ném.
 */
export function isTenantMembershipRef(value: unknown): value is TenantMembershipRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isOpaqueId((value as TenantMembershipRef).tenantId) &&
    isOpaqueId((value as TenantMembershipRef).actor)
  );
}

/**
 * Đảm bảo mọi phần tử của `items` là tham chiếu thành viên nằm trong đúng
 * `tenantId`. `tenantId` không qua isOpaqueId khiến toàn bộ tập hợp bị từ chối
 * với lý do 'inconsistent_context', không ném. Bất kỳ phần tử sai tenant hoặc
 * sai hình dạng (bao gồm null và không phải đối tượng) cũng từ chối TOÀN BỘ
 * tập hợp với lý do 'inconsistent_context' — không lọc lặng. `items` không phải
 * mảng cũng bị từ chối tương tự, không ném. Mảng rỗng hợp lệ với danh sách refs
 * trống.
 */
export function ensureTenantScopedMembershipRefs(
  tenantId: string,
  items: readonly unknown[],
):
  | { ok: true; refs: readonly TenantMembershipRef[] }
  | { ok: false; reason: 'inconsistent_context' } {
  if (!isOpaqueId(tenantId)) {
    return { ok: false, reason: 'inconsistent_context' };
  }
  if (!Array.isArray(items)) {
    return { ok: false, reason: 'inconsistent_context' };
  }
  const refs: TenantMembershipRef[] = [];
  for (const item of items) {
    if (!isTenantMembershipRef(item) || item.tenantId !== tenantId) {
      return { ok: false, reason: 'inconsistent_context' };
    }
    refs.push(item);
  }
  return { ok: true, refs: Object.freeze(refs) };
}
