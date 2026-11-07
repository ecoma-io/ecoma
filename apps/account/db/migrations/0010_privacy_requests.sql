-- 0010_privacy_requests.sql — bảng privacy_requests của data domain v1.
--
-- Phạm vi: `privacy_requests` — bảng mà `01-architecture.md` §3.2 mô tả
-- ("yêu cầu data subject: export | correct | delete | restrict | object;
-- trạng thái + deadline") nhưng schema chưa có. PR này (PR4 của Issue #274)
-- thêm bảng **và** đường BFF tạo/liệt kê của chính chủ; vòng đời xử lý phía
-- data-subject-workflow (orchestration, export thật, thông báo hoàn tất) là
-- việc của PR khác — FR-013a.
--
-- ⚠️ Forward-only: KHÔNG sửa file migration cũ. File này là expand — thêm bảng
--    mới, không đổi bảng nào.
--
-- ⚠️ IDEMPOTENT BẮT BUỘC (README "Advisory lock và idempotent"): runner không có
--    bảng ledger — nó chạy lại MỌI file mỗi lần apply. `CREATE TABLE IF NOT
--    EXISTS` và `GRANT` (bản chất lặp được) đều là no-op khi schema đã ở trạng
--    thái đích. Test `migrations.spec.ts` áp mọi file hai lần.
--
-- ## Quyết định v1 mà docs chưa chốt (reviewer có quyền veto)
--
--   * Trạng thái: `pending` (vừa nộp) → `in-progress` (đang xử lý) →
--     `completed` | `rejected`. Khớp chính xác bốn trạng thái mà UI của PR này
--     render (type `PrivacyRequestStatus`); docs chưa chốt bộ trạng thái.
--   * `deadline_at` được ghi **một lần lúc tạo** và KHÔNG có đường kéo dài
--     (FR-014: request hỏng không được kéo dài deadline) — không route nào
--     UPDATE cột này; bảng cũng không có cột "extended". Số ngày (30) là quyết
--     định v1 khi chưa có kết luận pháp lý (§7.1 bảng quyết định mở) — reviewer
--     hoặc quyết định pháp lý sau này đổi được bằng forward-fix.
--   * Không FK về `users` (`subject_sub` là tham chiếu opaque không ràng buộc,
--     cùng đối xử với `security_events`): hàng là nhóm (3) — sống sót qua
--     tombstone, vì bằng chứng "đã nhận yêu cầu" không được biến mất khi account
--     bị xoá (01-architecture.md §7.1 nhóm 3).
--   * KHÔNG JSONB: `kind`/`status` là CHECK allowlist đóng (cùng lập luận
--     §3.3 — "typed column, không JSONB" cho dữ liệu có contract đọc ra ngoài).
--   * Không surrogate id — ràng buộc nghiệp vụ là "một request **đang mở** cho
--     mỗi loại": partial UNIQUE INDEX chỉ phủ `pending`/`in-progress` (OCR
--     review của PR này). Nộp lại sau khi hàng cũ `completed`/`rejected` được
--     chấp nhận và tạo hàng mới — lịch sử request của subject phải giữ được
--     nhiều hàng cùng loại qua thời gian, nên không thể dùng composite PK
--     vô điều kiện trên (subject_sub, kind): nó khoá vĩnh viễn khả năng nộp
--     lại sau khi hàng đầu tiên kết thúc. `created_at` vào PK theo nhóm (3)
--     tombstone-safety: mọi hàng giữ nguyên vẹn, không hàng nào thay thế được.
--   * `updated_at` — khi nào trạng thái đổi lần cuối; thứ mà FR-015 (trạng thái
--     hỏng phải nhìn thấy được) cần khi hiển thị danh sách.

BEGIN;

CREATE TABLE IF NOT EXISTS account.privacy_requests (
  -- Tham chiếu opaque không FK (comment đầu file). Index prefix phục vụ truy
  -- vấn "danh sách của chính chủ" của GET /api/privacy-requests.
  subject_sub text NOT NULL,
  -- Loại yêu cầu — allowlist đóng của FR-013 / CR-001.
  kind text NOT NULL,
  -- pending | in-progress | completed | rejected. v1 chỉ TẠO (pending); các
  -- trạng thái sau là của vòng đời orchestration (FR-013a), không có đường
  -- ghi nào trong PR này chạm chúng.
  status text NOT NULL DEFAULT 'pending',
  -- Deadline một lần lúc tạo — xem phần "Quyết định v1" ở đầu file.
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT privacy_requests_kind_check CHECK (
    kind IN ('export', 'correct', 'delete', 'restrict', 'object')
  ),
  CONSTRAINT privacy_requests_status_check CHECK (
    status IN ('pending', 'in-progress', 'completed', 'rejected')
  ),
  -- PK (subject_sub, kind, created_at): định danh hàng + tombstone-safety nhóm
  -- (3). Ràng buộc nghiệp vụ "một request đang mở cho mỗi loại" là partial
  -- UNIQUE INDEX ngay dưới đây — KHÔNG phải PK (comment "Quyết định v1").
  PRIMARY KEY (subject_sub, kind, created_at)
);

-- Một request đang mở cho mỗi (subject, kind): nộp lại cùng loại khi còn hàng
-- `pending`/`in-progress` bị chặn (idempotent — route POST trả 200 với hàng
-- hiện có); nộp lại sau khi hàng cũ `completed`/`rejected` tạo hàng mới.
CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_open_unique_idx
  ON account.privacy_requests (subject_sub, kind)
  WHERE status IN ('pending', 'in-progress');

COMMENT ON TABLE account.privacy_requests IS
  'Data-subject requests (export | correct | delete | restrict | object) with status and statutory deadline. subject_sub is an opaque reference without FK so records survive tombstone (group 3, FR-013, FR-014).';
COMMENT ON COLUMN account.privacy_requests.subject_sub IS
  'Opaque subject reference. No FK by design: the request record must survive account deletion (group 3 retention).';
COMMENT ON COLUMN account.privacy_requests.kind IS
  'Request kind. Closed allowlist per FR-013 / CR-001: export | correct | delete | restrict | object.';
COMMENT ON COLUMN account.privacy_requests.status IS
  'pending | in-progress | completed | rejected. v1 writes only pending at creation; later transitions belong to the orchestration service (FR-013a).';
COMMENT ON COLUMN account.privacy_requests.deadline_at IS
  'Statutory response deadline, written once at creation and never extended (FR-014). v1 uses 30 days pending a legal determination.';

-- Truy vấn duy nhất của GET /api/privacy-requests: "mọi request của một sub,
-- mới nhất trước". Index duy nhất ngoài PK + partial unique index của bảng.
CREATE INDEX IF NOT EXISTS privacy_requests_subject_created_idx
  ON account.privacy_requests (subject_sub, created_at DESC);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- Grant nằm ở file tạo bảng — cùng luật với 0008. Bảng thuộc nhóm (3): vòng
-- đời của nó qua quy trình retention, không qua DELETE của luồng xoá account,
-- nên grant không cấp DELETE (khác ba bảng nhóm (2) của 0008). INSERT cho đường
-- tạo; SELECT cho danh sách; UPDATE cho vòng đời orchestration sau này (trạng
-- thái đổi) — cấp sẵn để vòng đời không phải mở rộng grant, revoke không bao
-- giờ là thao tác của bảng này (hàng kết thúc giữ nguyên làm bằng chứng).
GRANT SELECT, INSERT, UPDATE ON TABLE account.privacy_requests TO ecoma_account_runtime;

COMMIT;
