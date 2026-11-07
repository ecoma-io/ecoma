-- 0003_push_rate_limits.sql — counter rate limit của `POST /v1/notifications`.
--
-- Nguồn: docs/applications/push-notification/02-requirements.md FR-021 (rate limit theo `app`,
--        vượt ngân sách → từ chối rõ ràng chứ không drop âm thầm), FR-008 (fan-out limit);
--        docs/applications/push-notification/03-operations.md §7.4 (infrastructure secret),
--        §13 (retention/cleanup).
--
-- ⚠️ **Bảng này là một quyết định đã được document, và inventory D1 của
-- `03-operations.md` §8 chưa liệt kê nó.** §8 liệt kê 11 bảng và không có
-- `push_rate_limits`, trong khi FR-021 **bắt buộc** rate limit theo `app`. Vậy nên
-- inventory và requirement đang lệch nhau; quyết định ở đây là **thêm bảng** (giữ FR-021
-- là bắt buộc) và **mở rộng inventory docs** là việc của Lead. Ghi chú này tồn tại để
-- migration không bị đọc như một lệch âm thầm với §8.
--
-- ⚠️ **Vì sao rate limit phải bền (bảng) chứ không phải counter trong memory:** D1 `push` là
-- authority (`01-architecture.md` §12); một Worker có nhiều isolate nên counter trong memory
-- vừa cho qua vượt ngưỡng vừa mất đếm khi isolate bị recycle — đúng loại state node-local mà
-- invariant của repo cấm.
--
-- Mô hình **fixed window theo `app`**: một dòng là một counter đang mở cho đúng một `App`.
-- Lệnh gọi là **một** `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING` nên hai request
-- đồng thời không cùng "thừa" một slot, và **không** có đường read-then-write nào ở đây.
--
-- `limit` và `window_duration` **không** có cột: chúng là tham số cấu hình của
-- `push-notification`, được truyền vào tầng application mỗi lần gọi. Đổi ngưỡng là đổi
-- config, không phải migration — cùng kết luận với `max publish attempts` của outbox (§4).

CREATE TABLE push_rate_limits (
  app TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  -- Một `App` có **đúng một** counter đang mở → khoá chính chỉ cần `app`. Đây cũng là hệ quả
  -- của FR-021: scope **duy nhất** của rate limit là `app` (lấy từ authenticated
  -- principal), không phải IP và không phải `principal_id` — hai application khác nhau
  -- phải có hạn mức riêng.
  CONSTRAINT push_rate_limits_pkey PRIMARY KEY (app),

  CONSTRAINT push_rate_limits_app_non_empty_check CHECK (app <> ''),

  -- `hits >= 1`: mỗi lần mở cửa sổ mới là một lần tiêu slot đầu tiên (nhánh
  -- `window_started_at <= cutoff` của UPSERT ghi `hits = 1`), nên `hits = 0` là dữ liệu hỏng.
  -- Cột này KHÔNG có CHECK "chưa vượt limit": `limit` là tham số cấu hình, không phải
  -- constraint của schema — một CHECK hardcode sẽ biến việc đổi ngưỡng thành migration.
  CONSTRAINT push_rate_limits_hits_check CHECK (hits >= 1)
);

-- Quét counter cũ khi cleanup theo retention (`03-operations.md` §13). Dùng chung với
-- đường `updated_at` của các bảng khác: một fixed window tự đóng khi
-- `window_started_at` cũ đi, nên hàng này chỉ là "counter của cửa sổ đã đóng" và không còn
-- ý nghĩa sau khi quá hạn.
CREATE INDEX push_rate_limits_updated_at_idx ON push_rate_limits (updated_at);