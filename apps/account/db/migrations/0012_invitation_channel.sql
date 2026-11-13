-- 0012_invitation_channel.sql — bảng lời mời của kênh tạo Account ngoài bootstrap.
--
-- Quyết định nguồn: ADR-0030 (accepted, PR #214) — lời mời là bản ghi
-- authorization cho việc sinh MỘT Account mới cho MỘT địa chỉ; dữ liệu thuộc
-- `account` (nó điều chỉnh điều kiện tồn tại của `account.users`), không phải
-- dữ liệu authorization của `staff-access`. FR-002b của domain model §9.1.
--
-- Nội dung tối thiểu theo ADR-0030 Quyết định 1: `address_hash` +
-- `address_normalized` của địa chỉ được mời; trạng thái
-- `open | accepted | revoked | expired`; thời điểm phát + hết hạn; attribution
-- của người phát (`actor_sub`/`actor_staff_id`); `correlation_id`. Cột
-- `accepted_at`/`accepted_sub` ghi lại cặp phát/chấp nhận để trả lời được
-- "ai mời, ai nhận" (Quyết định 5) mà không phải join sang bảng audit.
--
-- Bất biến do ràng buộc giữ, không phải quy tắc app:
--   * Một địa chỉ có TỐI ĐA MỘT lời mời còn mở — partial UNIQUE index
--     `(address_hash) WHERE status = 'open'` (cùng tính chất first-binding-wins
--     của `login_handoffs`): hai lời mời mở cho cùng địa chỉ là bất khả thi ở
--     tầng database, kể cả dưới tải đồng thời.
--   * Lời mời single-use: trigger lifecycle ở dưới chặn mọi UPDATE từ trạng thái
--     kết thúc (`accepted`/`revoked`/`expired`) và chỉ cho `open` đi tiếp sang
--     một trong ba trạng thái đó — `accepted` vĩnh viễn, không tái sử dụng.
--   * Cặp trạng thái: `accepted` phải có cả `accepted_at` + `accepted_sub`;
--     trạng thái khác thì không (CHECK, cùng hình với
--     `email_addresses_verified_pair_check`).
--
-- ⚠️ Forward-only, idempotent: cùng quy ước với `0005`/`0006`. Runner không có
--    bảng ledger — nó chạy lại MỌI file mỗi lần apply; mọi câu ở đây là no-op
--    khi schema đã ở trạng thái đích. Test `migrations.spec.ts` áp mọi file hai
--    lần.
--
-- ⚠️ Migration này CHƯA trả quyền INSERT `account.users` cho runtime — guard
--    của `0011` giữ nguyên sau file này. Việc thu hẹp guard là migration
--    `0013`, chạy SAU khi bảng lời mời tồn tại: quyền INSERT mới được trả kèm
--    điều kiện ràng buộc bằng dữ liệu lời mời (ADR-0030 Quyết định 5), và
--    trigger của `0013` tham chiếu bảng được tạo ở đây.

BEGIN;

CREATE TABLE IF NOT EXISTS account.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Khoá tra cứu của mọi đường đọc: phát (kiểm exclusivity + một-lời-mời-mở),
  -- challenge (địa chỉ có lời mời mở được gửi mã thật), chấp nhận (khoá hàng
  -- FOR UPDATE). SHA-256 hex của `address_normalized` — cùng quy ước với
  -- `email_addresses.address_hash` và `otp_challenges.address_hash`; không đảo
  -- ngược được về địa chỉ trần trong index hay log.
  address_hash text NOT NULL,
  -- Địa chỉ đã normalize (lowercase + trim) — dạng nội bộ, không phải dạng
  -- hiển thị; app là nơi duy nhất gọi `normalizeEmailAddress`
  -- (`server/lib/otp.ts`).
  address_normalized text NOT NULL,
  -- `open` → `accepted` | `revoked` | `expired`. Chỉ `open` còn thao tác được;
  -- ba trạng thái kia là kết thúc (trigger lifecycle dưới đây).
  status text NOT NULL DEFAULT 'open',
  -- Attribution của người phát (ADR-0030 Quyết định 1): principal lấy từ
  -- credential đã xác thực của request phát (envelope HMAC), KHÔNG từ body
  -- người gọi. `actor_sub` là `account.users.sub` của operator;
  -- `actor_staff_id` do phía staff-access phân giải khi verdict cho phép.
  actor_sub text NOT NULL,
  actor_staff_id text,
  -- Id tương quan của lần phát — nối hàng lời mời với audit phát/denied ở
  -- phía quyết định (`staff_access.authorization_audit`, ADR-0023 Quyết định 6)
  -- và với provenance chấp nhận ở `security_events`.
  correlation_id text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Cặp chấp nhận: chỉ trạng thái `accepted` có cả hai, và `accepted_sub`
  -- trỏ đúng sub vừa sinh trong cùng transaction chấp nhận (ADR-0030 Quyết
  -- định 2). Không FK sang `users`: hàng users được INSERT TRƯỚC cặp UPDATE
  -- này trong transaction thật, còn FK sẽ ép thứ tự ngược; tính hợp lệ của
  -- `accepted_sub` do chính transaction chấp nhận bảo đảm (cùng client, cùng
  -- commit) và `users.sub` không bao giờ tái sử dụng nên tham chiếu không đổi
  -- nghĩa (FR-001).
  accepted_at timestamptz,
  accepted_sub text,
  CONSTRAINT invitations_status_check CHECK (status IN ('open', 'accepted', 'revoked', 'expired')),
  CONSTRAINT invitations_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT invitations_hash_shape_check CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invitations_normalized_shape_check CHECK (length(address_normalized) > 0),
  CONSTRAINT invitations_actor_shape_check CHECK (length(actor_sub) > 0),
  CONSTRAINT invitations_correlation_shape_check CHECK (length(correlation_id) > 0),
  CONSTRAINT invitations_accepted_pair_check CHECK (
    (status = 'accepted') = (accepted_at IS NOT NULL AND accepted_sub IS NOT NULL)
  )
);

COMMENT ON TABLE account.invitations IS
  'Authorization record for creating one Account for one address (ADR-0030). Single-use: accepted is terminal; at most one open invitation per address (partial UNIQUE).';
COMMENT ON COLUMN account.invitations.address_hash IS
  'SHA-256 hex of address_normalized. Lookup key of issue/challenge/accept; not reversible.';
COMMENT ON COLUMN account.invitations.status IS
  'open -> accepted | revoked | expired. Terminal states reject every UPDATE (trigger); accepted is permanent (single-use).';
COMMENT ON COLUMN account.invitations.actor_sub IS
  'Subject sub of the issuing operator, taken from the authenticated credential of the issue request, never from the body (ADR-0030 Decision 3).';
COMMENT ON COLUMN account.invitations.actor_staff_id IS
  'Staff identity of the issuer, resolved by staff-access when the permission verdict allowed the issuance.';
COMMENT ON COLUMN account.invitations.correlation_id IS
  'Correlation id of the issuance attempt; joins this row with the staff-access side audit and the acceptance provenance event.';
COMMENT ON COLUMN account.invitations.accepted_sub IS
  'Subject sub created by the acceptance transaction; set together with accepted_at exactly when status becomes accepted.';

-- Bất biến "một địa chỉ có tối đa một lời mời còn mở" — partial UNIQUE index,
-- đồng thời là index tra cứu của đường phát (exclusivity), đường challenge và
-- đường chấp nhận (đều lọc `status = 'open'` theo `address_hash`). Không index
-- riêng cho truy vấn đó — index trùng lặp chỉ tốn ghi
-- (`01-architecture.md` §3.2).
CREATE UNIQUE INDEX IF NOT EXISTS invitations_open_hash_unique_idx
  ON account.invitations (address_hash)
  WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Lifecycle guard: forward-only từ `open`; trạng thái kết thúc là kết thúc
-- ---------------------------------------------------------------------------
--
-- Cùng hình với `login_handoffs_rebind_guard` (`0001`): CHECK constraint chỉ
-- giữ tuyến giá trị của MỘT hàng, còn các tuyến TRẠNG THÁI cần trigger vì
-- runtime role có UPDATE trên bảng. Bốn nhóm luật:
--   0. `address_hash`/`address_normalized` không đổi được: chúng là định danh
--      của lời mời — đổi địa chỉ sau khi phát là đổi chủ của authorization
--      record, và một lời mời `accepted` bị đổi hash là cách xoá dấu vết
--      "địa chỉ nào đã được mời".
--   1. Trạng thái kết thúc (`accepted`/`revoked`/`expired`) từ chối MỌI UPDATE:
--      `accepted` vĩnh viễn là cơ chế single-use (ADR-0030 Quyết định 1),
--      `revoked` giữ nguyên `revoked`-ý nghĩa như assignment của staff-access
--      (không hồi sinh bằng UPDATE im lặng), `expired` không gia hạn âm thầm.
--   2. Từ `open` chỉ đi tiếp sang một trong ba trạng thái kết thúc — quay lại
--      `open` hay đặt `open` lại từ đâu khác là mở lại cửa sổ dùng một lời mời
--      đã đóng.
--   3. `issued_at` không đổi: mốc phát là một nửa của cặp TTL và của điều kiện
--      "challenge đã tiêu thụ sau khi phát" trong guard INSERT `users` của
--      `0013`.

CREATE OR REPLACE FUNCTION account.invitations_lifecycle_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.address_hash IS DISTINCT FROM OLD.address_hash
     OR NEW.address_normalized IS DISTINCT FROM OLD.address_normalized THEN
    RAISE EXCEPTION
      'invitations: dia chi cua loi moi khong duoc doi sau khi phat; doi hash la doi chu cua authorization record (ADR-0030)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status IN ('accepted', 'revoked', 'expired') THEN
    RAISE EXCEPTION
      'invitations: hang da % la trang thai ket thuc, khong duoc UPDATE nua; accepted la single-use vinh vien (ADR-0030 Quyết định 1)',
      OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status NOT IN ('accepted', 'revoked', 'expired') THEN
    RAISE EXCEPTION
      'invitations: tu open chi duoc di tiep sang accepted, revoked hoac expired (ADR-0030)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION
      'invitations: issued_at khong duoc doi; no la moc cua TTL va cua dieu kien challenge-tieu-thu trong guard INSERT users (0013)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION account.invitations_lifecycle_guard() IS
  'Forward-only lifecycle from open; accepted/revoked/expired are terminal (single-use, ADR-0030); the address and issued_at of an issued invitation are immutable.';

DROP TRIGGER IF EXISTS invitations_lifecycle_guard ON account.invitations;
CREATE TRIGGER invitations_lifecycle_guard
  BEFORE UPDATE ON account.invitations
  FOR EACH ROW
  EXECUTE FUNCTION account.invitations_lifecycle_guard();

-- Grant nằm ở file tạo bảng — cùng luật với `0005`/`0006`. Runtime cần
-- SELECT (tra cứu open/exclusivity, guard INSERT users của `0013` đọc qua
-- trigger SECURITY INVOKER), INSERT (đường phát), UPDATE (chấp nhận sang
-- `accepted`, lazy-mark `expired`). KHÔNG DELETE: lời mời là dữ liệu authorization
-- có dấu vết — thu hồi là chuyển trạng thái có audit, không xoá hàng
-- (ADR-0030 Quyết định 1); retention là quyết định còn mở của component.
GRANT SELECT, INSERT, UPDATE ON TABLE account.invitations TO ecoma_account_runtime;

COMMIT;
