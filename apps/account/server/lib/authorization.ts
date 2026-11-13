/**
 * Cổng enforcement quyền phát lời mời — mặt fail-closed của ADR-0030 Quyết
 * định 3.
 *
 * ## Vì sao file này tồn tại dưới dạng "cổng luôn trả unavailable"
 *
 * ADR-0030 Quyết định 3 đòi verdict permission **theo từng request** lấy từ
 * `staff-access` qua credential của operator — quyết định authorization thuộc
 * về `staff-access` (data ownership), `account` không tự suy ra quyền từ trạng
 * thái của mình. Nhưng hiện trạng repo (kiểm tại thời điểm slice này, #227):
 *
 * - `apps/staff-access` chỉ có đường envelope HMAC nội bộ + gate "staff còn
 *   active"; **không có endpoint nào trả verdict permission** — hợp đồng
 *   authorization-result nội bộ đầu tiên chưa tồn tại.
 * - ADR-0009 đã chốt **không** có hợp đồng authorization-result nội bộ, và
 *   việc tạo một hợp đồng mới **đòi ADR mới** — quyết định vượt scope lock
 *   `apps/account/**` của slice này.
 *
 * Vì vậy đường phát gọi {@link authorizeInvitationIssuance} như một cổng có
 * hợp đồng rõ (union ba verdict), còn implementation production **luôn trả
 * `unavailable`** → route trả 503 với reason
 * `authorization_surface_unavailable`. Không bịa wire contract, không hỏi
 * permission ở bất kỳ đâu khác, không fallback sang trạng thái `account` —
 * mọi lựa chọn thay thế đều vi phạm ADR-0009 hoặc invariant ownership.
 *
 * ## Khi staff-access có hợp đồng verdict (theo dõi #44)
 *
 * Thay **chỉ** thân hàm bên dưới thành lời gọi network tới endpoint verdict
 * mới của staff-access (credential: envelope HMAC với `actorSub` trong header
 * nội bộ); hình trả về và fail-closed giữ nguyên. Route `invitations.post.ts`
 * và test không phải đổi. Fail-closed nghĩa là: lỗi network, timeout hay
 * response không đọc được đều chảy về `unavailable` — **không bao giờ** suy
 * ra `allowed` từ một lỗi (SR-020: denial mặc định khi thiếu bằng chứng).
 */

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
      /** Operator bị từ chối quyền — route trả 403, ghi audit denied. */
      readonly verdict: 'denied';
    }
  | {
      /**
       * Không hỏi được verdict (lỗi network, hợp đồng chưa tồn tại) — route
       * trả 503, **không** ghi audit denied (đây không phải quyết định
       * authorization của staff-access, chỉ là mặt serving của account đang
       * thiếu phụ thuộc).
       */
      readonly verdict: 'unavailable';
      /** Lý do kỹ thuật — an toàn để log, không chứa dữ liệu người dùng. */
      readonly reason: IssuanceUnavailableReason;
    };

/** Mã lý do `unavailable` — danh sách đóng để test và log khớp từng trường hợp. */
export type IssuanceUnavailableReason =
  | 'authorization_contract_not_established'
  | 'authorization_surface_unreachable';

/**
 * Hỏi staff-access xem operator có quyền {@link INVITATION_CREATE_PERMISSION}
 * không — cho **một** request phát, không cache, không suy ra từ trạng thái
 * `account` (ADR-0030 Quyết định 3).
 *
 * ⚠️ Implementation hiện tại là **fail-closed cố ý**: luôn trả `unavailable`
 * với reason `authorization_contract_not_established`. Đây là khai báo đúng
 * hiện trạng (ADR-0009 — hợp đồng verdict chưa tồn tại, phải có ADR mới
 * trước), không phải TODO vô chủ: mục tiêu thay thân hàm và chủ sở hữu tiếp
 * theo được ghi ở Issue #44 (staff-appointment dùng chung hợp đồng verdict
 * này). Cấm "giải quyết tạm" bằng cách đọc bảng quyền từ `account` hay từ
 * `staff-access` trực tiếp qua DB — invariant ownership và ADR-0009 đều cấm.
 */
export async function authorizeInvitationIssuance(
  _actorSub: string,
): Promise<IssuanceAuthorization> {
  return {
    verdict: 'unavailable',
    reason: 'authorization_contract_not_established',
  };
}
