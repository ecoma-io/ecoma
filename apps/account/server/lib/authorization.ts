/**
 * Cổng enforcement quyền phát lời mời — mặt fail-closed của ADR-0030 Quyết
 * định 3, dùng hợp đồng verdict nội bộ của `staff-access` (ADR-0033 Quyết
 * định 3).
 *
 * ## Hướng của phép kiểm
 *
 * `account` **không** tự suy quyền từ trạng thái của mình và **không** đọc dữ
 * liệu assignment của `staff-access` (ADR-0030 Quyết định 3). Mỗi request phát
 * lời mời hỏi thẳng `staff-access` — nơi sở hữu catalog và assignment — qua
 * `POST /authorization/verdict`; verdict là read-time, không cache, và
 * `staff-access` ghi hàng audit `denied`/`success` tương ứng trước khi trả lời
 * (ADR-0023 Quyết định 6).
 *
 * ## Fail-closed, ba nhánh
 *
 * - `allowed` → route đi tiếp, dùng `actorStaffId` do `staff-access` phân giải
 *   cho attribution.
 * - `denied` → route trả 403; hàng audit `denied` đã nằm ở
 *   `staff_access.authorization_audit`, phía `account` chỉ ghi log serving.
 * - `unavailable` → route trả 503 và **không** phát. Không có nhánh "cho qua
 *   khi không hỏi được": denial mặc định khi thiếu bằng chứng (SR-020).
 *
 * Chỉ response `200` của `staff-access` mới là một verdict. `403` của middleware
 * bên đó ("actor không phải staff active") chảy về `unavailable`, không thành
 * `denied`: một phán quyết `denied` phải có hàng audit đi kèm, và `403` đó
 * không có.
 */

import { requestPermissionVerdict, staffAccessServiceBinding } from './staff-access-client';

/** Literal permission của hành động phát lời mời (ADR-0010: `domain.action`). */
export const INVITATION_CREATE_PERMISSION = 'invitation.create';

/** Kết quả enforcement phát lời mời — danh sách đóng, không chuỗi tự do. */
export type IssuanceAuthorization =
  | {
      /** Operator có quyền `invitation.create` — đi tiếp sang phát. */
      readonly verdict: 'allowed';
      /** Staff identity của operator do phía staff-access phân giải. */
      readonly actorStaffId: string;
    }
  | {
      /** Operator bị từ chối quyền — route trả 403, audit denied ở staff-access. */
      readonly verdict: 'denied';
    }
  | {
      /**
       * Không hỏi được verdict (thiếu cấu hình, lỗi transport, response sai
       * hợp đồng) — route trả 503, **không** ghi audit denied ở đâu cả: đây
       * không phải quyết định authorization, chỉ là mặt serving của `account`
       * đang thiếu phụ thuộc.
       */
      readonly verdict: 'unavailable';
      /** Lý do kỹ thuật — an toàn để log, không chứa dữ liệu người dùng. */
      readonly reason: IssuanceUnavailableReason;
    };

/** Mã lý do `unavailable` — danh sách đóng để test và log khớp từng trường hợp. */
export type IssuanceUnavailableReason =
  /** Thiếu binding `STAFF_ACCESS_SERVICE` hoặc secret của path này. */
  | 'authorization_surface_not_configured'
  /** Không gọi được `staff-access` (network, timeout, hoặc chính nó đang 503). */
  | 'authorization_surface_unreachable'
  /** `staff-access` từ chối request (envelope hỏng, actor không phải staff active). */
  | 'authorization_surface_rejected'
  /** `staff-access` trả 200 nhưng body khác hợp đồng verdict. */
  | 'authorization_surface_invalid_response';

/**
 * Hỏi `staff-access` xem operator có quyền {@link INVITATION_CREATE_PERMISSION}
 * không — cho **một** request phát.
 *
 * @param params.runtimeConfig - `useRuntimeConfig(event)` của route; đọc binding và
 *   secret của path này từ đó, không đọc `process.env` ở bất kỳ đâu.
 * @param params.actorSub - `sub` của operator, lấy từ envelope đã verify.
 * @param params.correlationId - Định danh của chính request này; chuyển nguyên văn
 *   xuống `staff-access` để hàng audit ở đó truy được bằng cùng một giá trị.
 */
export async function authorizeInvitationIssuance(params: {
  readonly runtimeConfig: unknown;
  readonly actorSub: string;
  readonly correlationId: string;
}): Promise<IssuanceAuthorization> {
  const binding = staffAccessServiceBinding(params.runtimeConfig);

  // ⚠️ **Không dùng chung `internalHmacSecret`**, và credential được đọc ngay tại
  // điểm dùng chứ không trả ra khỏi một hàm phụ: nó là giá trị mà `staff-access`
  // verify (`AUTH_INTERNAL_SECRET` của bên đó), không phải giá trị của path
  // Account↔Auth. Trộn hai secret là lỗi cấu hình mà không gì bắt được cho tới
  // khi chữ ký lệch ở production — cùng lập luận `mailInternalAuthSecret`.
  const config = params.runtimeConfig as { staffAccessInternalAuthSecret?: unknown } | undefined;
  const rawKey = config === undefined ? undefined : config.staffAccessInternalAuthSecret;
  const signingKey = typeof rawKey === 'string' && rawKey.length > 0 ? rawKey : null;

  if (binding === null || signingKey === null) {
    return { verdict: 'unavailable', reason: 'authorization_surface_not_configured' };
  }

  const result = await requestPermissionVerdict({
    binding,
    signingKey,
    actorSub: params.actorSub,
    permission: INVITATION_CREATE_PERMISSION,
    correlationId: params.correlationId,
  });

  if (!result.ok) {
    // `binding_missing` / `secret_missing` không thể xảy ra ở đây: caller đã
    // kiểm `binding === null || signingKey === null` ở trên và trả sớm với
    // `authorization_surface_not_configured` — hai giá trị đó do caller sở hữu,
    // `requestPermissionVerdict` nhận tham số đã qua kiểm và không trả lại.
    switch (result.reason) {
      case 'rejected':
        return { verdict: 'unavailable', reason: 'authorization_surface_rejected' };
      case 'invalid_response':
        return { verdict: 'unavailable', reason: 'authorization_surface_invalid_response' };
      case 'unreachable':
      case 'staff_access_unavailable':
        return { verdict: 'unavailable', reason: 'authorization_surface_unreachable' };
    }
  }

  return result.verdict === 'allowed'
    ? { verdict: 'allowed', actorStaffId: result.actorStaffId }
    : { verdict: 'denied' };
}
