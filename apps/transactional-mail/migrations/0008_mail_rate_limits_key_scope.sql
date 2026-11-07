-- 0008_mail_rate_limits_key_scope.sql — thêm hình thức rate limit theo idempotency key.
--
-- Nguồn: docs/applications/transactional-mail/02-requirements.md FR-002 ("Probe `409` trên cùng
--        `(principal_id, idempotency_key)` bị rate limit theo **key** (không chỉ theo
--        principal) → `429` khi vượt ngưỡng + security alert"); FR-006 (enforcement durable).
--
-- ⚠️ VÌ SAO FILE NÀY TỒN TẠI — và vì sao nó là một rebuild bảng.
--
-- `0005_mail_rate_limits.sql` đã dự báo đúng việc này ngay trong ghi chú của nó: schema của
-- C1 đóng `scope_kind` ở đúng hai giá trị `{system, principal}` — hai mức FR-006 yêu cầu —
-- và ghi rõ hình thức "rate limit theo `(principal_id, idempotency_key)` cho các lần thử
-- bị `409`" của FR-002 **chưa** thuộc phạm vi C1, sẽ cần một expand migration. SQLite
-- không sửa được CHECK của một bảng đã có, nên lựa chọn duy nhất là **rebuild** — cùng
-- pattern đã đo trên D1 thật ở `0007_mail_content_redaction.sql`: tạo bảng tạm **không có
-- constraint nào**, copy, drop, dựng lại đầy đủ constraint, chép ngược bằng danh sách cột
-- tường minh, recreate index.
--
-- Mô hình scope mới: `scope_kind = 'idempotency-key'`, và `principal_id` mang
-- `<principal_id>:<idempotency_key_hash>` (hash hex do application layer tính — key gốc
-- của caller KHÔNG BAO GIỜ được ghi vào bảng này). Không thêm cột nào: counter vẫn là một
-- dòng cho một scope, khoá chính `(scope_kind, principal_id)` vẫn giữ bất biến "một scope
-- không bao giờ có hai dòng đua nhau". Đây là dữ kiện FR-006 giữ nguyên — chỉ mở danh sách
-- giá trị `scope_kind`.
--
-- ⚠️ PRAGMA defer_foreign_keys = on — cùng lý do với 0007: tài liệu ý định xử lý FK kiểu
-- hoãn; vô hại vì bảng này không có FK và mọi constraint đều hợp lệ ngay khi tạo.

PRAGMA defer_foreign_keys = on;

-- Bước 1 — bảng tạm, không khai constraint nào. Tên `_migration_0008_` để không bao giờ
-- trùng với tên bảng thật.
CREATE TABLE migration_0008_rate_limits_stage (
  scope_kind TEXT,
  principal_id TEXT,
  window_started_at INTEGER,
  hits INTEGER,
  updated_at INTEGER
);

-- Copy đúng thứ tự cột của bảng gốc (thứ tự cột là hợp đồng của `INSERT … SELECT *`).
INSERT INTO migration_0008_rate_limits_stage SELECT * FROM mail_rate_limits;

-- Bước 2 — drop bảng cũ (không FK trỏ tới nó, nên drop thẳng được).
DROP TABLE mail_rate_limits;

-- Bước 3 — dựng lại bảng, giữ nguyên mọi constraint của 0005 trừ đúng một:
-- `mail_rate_limits_scope_kind_check` mở thêm `'idempotency-key'`, và
-- `mail_rate_limits_scope_parity_check` thêm parity cho nhánh mới. Tên constraint giữ
-- nguyên để các khẳng định danh sách CHECK trong `mail-d1.spec.ts` không cần đổi.
CREATE TABLE mail_rate_limits (
  -- 'system' | 'principal' | 'idempotency-key'
  scope_kind TEXT NOT NULL,
  -- '' khi scope_kind = 'system'; principal do server kiểm soát khi scope_kind = 'principal';
  -- `<principal_id>:<hash hex của idempotency key>` khi scope_kind = 'idempotency-key'.
  principal_id TEXT NOT NULL DEFAULT '',
  -- Mốc bắt đầu cửa sổ hiện tại, epoch miligiây UTC. Window cũ hơn limit → reset.
  window_started_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  -- Khoá chính là đúng một counter cho mỗi scope. `ON CONFLICT` của repository đánh vào
  -- đúng bộ cột này, nên một scope không bao giờ có hai dòng đua nhau.
  CONSTRAINT mail_rate_limits_pkey PRIMARY KEY (scope_kind, principal_id),

  -- Ba hình thức: hai mức FR-006 và hình thức theo key của FR-002 (migration này mở thêm).
  CONSTRAINT mail_rate_limits_scope_kind_check CHECK (
    scope_kind IN ('system', 'principal', 'idempotency-key')
  ),

  -- Parity phạm vi: hệ thống không có principal; một principal thì không để rỗng; nhánh
  -- theo key thì giá trị phải mang đúng một dấu `:` phân cách (application layer ghim
  -- principal không chứa `:` và hash là hex — parity ở đây là lưới cuối cùng).
  CONSTRAINT mail_rate_limits_scope_parity_check CHECK (
    (scope_kind = 'system') = (principal_id = '')
    AND (scope_kind = 'idempotency-key') = (
      principal_id LIKE '%:%'
      AND principal_id NOT LIKE '%:%:%'
    )
  ),

  -- Counter không âm và window luôn có mốc.
  CONSTRAINT mail_rate_limits_hits_check CHECK (hits >= 0),
  CONSTRAINT mail_rate_limits_window_started_at_check CHECK (window_started_at > 0)
);

-- Bước 4 — chép ngược dữ liệu bằng danh sách cột tường minh (lệch thứ tự thành lỗi ngay).
INSERT INTO mail_rate_limits (scope_kind, principal_id, window_started_at, hits, updated_at)
SELECT
  scope_kind,
  principal_id,
  window_started_at,
  hits,
  updated_at
FROM migration_0008_rate_limits_stage;

-- Bảng tạm hết nhiệm việc. Nếu file chạy lại thì migration ledger đã chặn từ trước.
DROP TABLE migration_0008_rate_limits_stage;

-- Bảng này chưa từng có index ngoài PK (0005) — không có gì phải recreate.
