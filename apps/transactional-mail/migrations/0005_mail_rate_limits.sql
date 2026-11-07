-- 0005_mail_rate_limits.sql — counter rate limit bền trong D1 `mail`.
--
-- Nguồn: docs/applications/transactional-mail/02-requirements.md FR-006;
--        docs/applications/transactional-mail/01-architecture.md §8 (invariant 9: không state
--        node-local).
--
-- ⚠️ Enforcement PHẢI durable. Một Worker có nhiều isolate; bộ đếm nằm trong memory của isolate
-- sẽ vừa cho qua vượt ngưỡng vừa mất đếm khi isolate bị recycle. D1 `mail` là **authority**:
-- ngưỡng/limit do application layer truyền vào từng lệnh gọi, không suy ra từ số liệu cục bộ.
--
-- ⚠️ Ngưỡng và cửa sổ là **giá trị vận hành chốt ở deploy** (FR-006), cùng nhóm với
-- `maxRecoveryCycles`/`maxPublishAttempts`. Vì vậy bảng này KHÔNG lưu limit: nó chỉ lưu counter
-- và mốc cửa sổ. Mỗi lần gọi truyền `limit` vào guard, nên đổi ngưỡng là đổi runtime config
-- chứ không phải migration.
--
-- Mô hình: **fixed window theo scope**. Một dòng là một counter đang mở cho đúng một scope.
-- Lệnh gọi nguyên tử (`INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING`) sẽ reset window khi
-- window đã cũ, tăng `hits`, và từ chối khi `hits` vượt limit — mọi việc trong một câu lệnh,
-- nên hai request đồng thời không cùng "thừa" một slot.
--
-- ⚠️ `scope_kind` bị đóng ở đúng hai giá trị `{system, principal}` — đúng hai mức FR-006 yêu
-- cầu (một limit theo authenticated principal, một system-wide). FR-002 có nêu thêm một hình
-- thức rate limit theo `(principal_id, idempotency_key)` cho các lần thử bị `409`; hình thức
-- đó **chưa** thuộc phạm vi C1 và sẽ cần một expand migration để thêm scope kind mới (SQLite
-- không sửa được `CHECK` tại chỗ). Quyết định này được ghi nhận trong PR, không được suy ra
-- từ schema.
--
-- Mọi constraint đều đặt tên theo convention `CONSTRAINT <table>_<rule>_check`.

CREATE TABLE mail_rate_limits (
  -- 'system' | 'principal'
  scope_kind TEXT NOT NULL,
  -- '' khi scope_kind = 'system'; principal do server kiểm soát khi scope_kind = 'principal'.
  principal_id TEXT NOT NULL DEFAULT '',
  -- Mốc bắt đầu cửa sổ hiện tại, epoch miligiây UTC. Window cũ hơn limit → reset.
  window_started_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  -- Khoá chính là đúng một counter cho mỗi scope. `ON CONFLICT` của repository đánh vào
  -- đúng bộ cột này, nên một scope không bao giờ có hai dòng đua nhau.
  CONSTRAINT mail_rate_limits_pkey PRIMARY KEY (scope_kind, principal_id),

  -- Đúng hai hình thức FR-006 yêu cầu hôm nay — xem ghi chú mở rộng ở đầu file.
  CONSTRAINT mail_rate_limits_scope_kind_check CHECK (scope_kind IN ('system', 'principal')),

  -- Parity phạm vi: hệ thống không có principal, và một principal thì không được để rỗng.
  -- Hai nhánh loại trừ nhau, nên không thể tạo scope 'system' với principal thật hay scope
  -- 'principal' với principal rỗng.
  CONSTRAINT mail_rate_limits_scope_parity_check CHECK (
    (scope_kind = 'system') = (principal_id = '')
  ),

  -- Counter không âm và window luôn có mốc.
  CONSTRAINT mail_rate_limits_hits_check CHECK (hits >= 0),
  CONSTRAINT mail_rate_limits_window_started_at_check CHECK (window_started_at > 0)
);

-- Không thêm index ngoài PK: mọi lệnh gọi của FR-006 tra đúng theo `(scope_kind, principal_id)`
-- — tức là theo khoá chính. Không có đường quét nào cần index phụ.
