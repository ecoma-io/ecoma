-- 0013_invitation_users_insert_guard.sql — thu hẹp write-guard của `0011` cho
-- đúng điểm ADR-0030 Quyết định 5 chỉ ra.
--
-- `0011_bootstrap_write_guards.sql` thu hồi INSERT trên `account.users` khỏi
-- `ecoma_account_runtime` vì khi đó "bootstrap là đường ghi `users` duy nhất".
-- ADR-0030 (accepted, PR #214) mở đúng một đường ghi serving-path mới —
-- transaction chấp nhận lời mời — và quyết định này **thu hẹp đúng điểm đó một
-- cách tường minh**: serving path được trả lại quyền tạo `account.users` CHỈ
-- cho transaction chấp nhận lời mời, điều kiện ràng buộc bằng DỮ LIỆU (lời mời
-- còn mở cho `address_hash` + challenge đã tiêu thụ), qua forward migration
-- này. `0011` KHÔNG được sửa lại — forward-fix, replay được.
--
-- Hai điều kiện dữ liệu của guard (ADR-0030 Quyết định 5):
--   1. Tồn tại hàng `invitations` `status = 'accepted'` với `accepted_sub`
--      = `NEW.sub` — tức transaction ĐANG CHẠY vừa chuyển lời mời cho đúng sub
--      này sang `accepted` (đọc thấy write của chính mình trong transaction,
--      READ COMMITTED). Một đường code khác không thể "mượn" lời mời đã accept
--      cho sub khác: `accepted_sub` là của sub đã sinh trong transaction chấp
--      nhận, và `users.sub` là PRIMARY KEY nên sub đó không INSERT lại được.
--   2. Tồn tại challenge OTP đã tiêu thụ cho `address_hash` của lời mời đó,
--      tiêu thụ SAU thời điểm phát (`consumed_at >= issued_at`) — bằng chứng
--      "kiểm soát hộp thư đã được chứng minh", đúng mô hình tin cậy của ADR-0030
--      Quyết định 2. Challenge consume và INSERT `users` nằm trong cùng
--      transaction nên hai điều kiện cùng commit hoặc cùng không có gì.
--
-- Guard provenance của bootstrap GIỮ NGUYÊN (ADR-0030 Quyết định 5):
--   * `0011` chưa sửa — trigger `security_events_reserve_bootstrap_type` vẫn
--     chặn runtime ghi `type = 'bootstrap_account_provisioned'`, nên hai nguồn
--     gốc Account không bao giờ trộn được: bootstrap vẫn chỉ của migrator/owner
--     (principal `ecoma_account_migrator`, bỏ qua nhánh runtime của trigger
--     dưới đây qua phép kiểm `current_user`), lời mời vẫn chỉ của serving path.
--   * Trigger dưới đây là SECURITY INVOKER (cùng chọn với trigger của `0011`):
--     chạy dưới principal thực thi — chính credential runtime khi Worker gọi —
--     không phải metadata do caller kiểm soát. Nhánh runtime đọc hai bảng qua
--     SELECT của runtime (`invitations` được cấp ở `0012`, `otp_challenges` ở
--     `0006`); migrator/superuser đi qua nhánh cho-pass ngay từ phép kiểm
--     `current_user`, không cần SELECT nào.
--   * Phép kiểm cố ý khoá vào `current_user`, không `session_user`: cả hai cách
--     kết nối của harness (`SET ROLE` và credential trực tiếp) đều làm
--     `current_user` = role mục tiêu, còn `session_user` giữ nguyên role đăng
--     nhập. Nếu sau này đổi cơ chế giả lập quyền, xem lại phép kiểm này trước
--     khi tin nhánh runtime.
--
-- ⚠️ Idempotent: `GRANT` bản chất lặp được; `CREATE OR REPLACE FUNCTION` +
--    `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` chạy lại là no-op hình dạng.
--    Fail-closed assert ở cuối: nếu sau migration này runtime vẫn không có
--    INSERT (grant bị rút lại ở đâu đó) thì migration NÉM thay vì để serving
--    path hỏng im lặng lúc chấp nhận lời mời.

BEGIN;

-- Trả quyền INSERT cho runtime — quyền giờ bị trigger bên dưới ràng buộc bằng
-- dữ liệu lời mời, không phải quyền vô điều kiện như `0002` cấp trước `0011`.
GRANT INSERT ON TABLE account.users TO ecoma_account_runtime;

CREATE OR REPLACE FUNCTION account.users_invitation_birth_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  -- Chỉ ràng buộc principal runtime. Migrator/owner (bootstrap CLI) và owner
  -- đi qua không kiểm — bootstrap giữ nguyên hợp đồng của nó (ADR-0020/0021/0024).
  IF current_user = 'ecoma_account_runtime' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM account.invitations i
       WHERE i.accepted_sub = NEW.sub
         AND i.status = 'accepted'
         AND EXISTS (
           SELECT 1
             FROM account.otp_challenges c
            WHERE c.address_hash = i.address_hash
              AND c.consumed_at IS NOT NULL
              AND c.consumed_at >= i.issued_at
         )
    ) THEN
      RAISE EXCEPTION
        'ecoma_account_runtime may only insert account.users inside the invitation-acceptance transaction: no invitation accepted for this sub with an OTP challenge consumed after issuance (ADR-0030 Decision 5)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION account.users_invitation_birth_guard() IS
  'Narrows the 0011 bootstrap write guard (ADR-0030 Decision 5): the runtime principal may insert account.users only inside the invitation-acceptance transaction, bound by data — an invitation accepted for this sub with an OTP challenge consumed after issuance. Migrator/owner keeps the bootstrap path.';

DROP TRIGGER IF EXISTS users_invitation_birth_guard ON account.users;
CREATE TRIGGER users_invitation_birth_guard
  BEFORE INSERT ON account.users
  FOR EACH ROW
  EXECUTE FUNCTION account.users_invitation_birth_guard();

-- Khối assert fail-closed: chốt lại rằng sau migration này runtime CÓ INSERT
-- trên `account.users` (ở cấp bảng; grant theo cột không tồn tại cho bảng này
-- nên chỉ cần kiểm cấp bảng). Một môi trường mà grant này bị rút (script ad-hoc,
-- restore lệch) phải đỏ ở tầng migration thay vì để mọi lần chấp nhận lời mời
-- hỏng `permission denied` lúc có người thật nhận mời.
DO $$
BEGIN
  IF NOT has_table_privilege('ecoma_account_runtime', 'account.users', 'INSERT') THEN
    RAISE EXCEPTION
      'ecoma_account_runtime does not hold INSERT on account.users after 0013; the invitation-acceptance serving path cannot write — grant was lost'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

COMMIT;
