import { isOpaqueId } from './opaque-id';

/**
 * Một tenant theo kernel: định danh và owner, mỗi bên là một chuỗi opaque đã
 * verify. Kernel không định nghĩa lifecycle, status, bản revoke, hay timestamp
 * tạo/xoá — các concept đó thuộc bounded context của consumer.
 */

/** Một tenant có đúng một owner: định danh tenant và định danh người sở hữu. */
export interface OwnedTenant {
  readonly id: string;
  readonly owner: string;
}

/**
 * Bảo vệ hình dạng OwnedTenant: `id` và `owner` đều phải qua isOpaqueId. Bản
 * 기록 thiếu chủ sở hữu, sai định dang hoặc không phải đối tượng đều bị từ chối.
 * Không bao giờ ném.
 */
export function isOwnedTenant(value: unknown): value is OwnedTenant {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    isOpaqueId((value as OwnedTenant).id) &&
    isOpaqueId((value as OwnedTenant).owner)
  );
}

/**
 * Actor có phải owner của tenant không. Bảo vệ tenant TRƯỚC (cùng quy tắc hình
 * dạng của isOwnedTenant), rồi so sánh `owner === actor`. Trả false cho input
 * sai hình dạng — bao gồm cả tenant bị hỏng mà trường owner trùng actor — và
 * không bao giờ ném.
 */
export function isTenantOwnedBy(tenant: unknown, actor: unknown): boolean {
  if (!isOwnedTenant(tenant)) {
    return false;
  }
  return tenant.owner === actor;
}
