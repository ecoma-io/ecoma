-- 0003_mail_outbox.sql — bảng `mail_outbox`: outbox row cho mỗi logical delivery.
--
-- Nguồn: docs/applications/transactional-mail/01-architecture.md §4.3, §6.1–§6.5;
--        docs/applications/transactional-mail/02-requirements.md FR-004, NFR-003.
--
-- ⚠️ Hai lớp state tách nhau (§6.2.1). Bảng này là lớp publish state — "Queue command đã được
-- send chưa" — và KHÔNG BAO GIỜ ghi đè lên delivery outcome của `mail_messages`. Publisher chỉ
-- được ghi `mail_messages.status = queued` bằng conditional write với nguồn hợp lệ
-- `accepted`/`queued` và `dispatch_generation` khớp; `sent`/`failed`/`blocked` không bao giờ
-- là nguồn hợp lệ.
--
-- ⚠️ `delivery_id` là UNIQUE: redrive/repair tái sử dụng CHÍNH row outbox cũ, không tạo row
-- thứ hai, không đổi `delivery_id` (FR-004).
--
-- ⚠️ `publish_attempts` chỉ đếm lần thử trong chu kỳ publish hiện tại, bị reset khi row được
-- re-enqueue. Nó KHÔNG phải recovery cycle guard: ngân sách A nằm ở
-- `mail_messages.recovery_cycle_count` (§6.5). Hai bộ đếm không thay thế nhau.
--
-- ⚠️ Row `failed` KHÔNG bị xoá tự động (FR-004): `failed` chỉ nghĩa là publish tự động đã hết
-- `maxPublishAttempts` trong chu kỳ đó, không phải mất delivery intent. Recovery là alert +
-- repair có kiểm soát.
--
-- Mọi constraint đều đặt tên theo convention `CONSTRAINT <table>_<rule>_check`.

CREATE TABLE mail_outbox (
  id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  dispatch_generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  claimed_at INTEGER,
  claimed_by TEXT,
  published_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  -- `NOT NULL` ở cột là bắt buộc: trên rowid table, `PRIMARY KEY` không kèm `NOT NULL` vẫn cho NULL.
  CONSTRAINT mail_outbox_pkey PRIMARY KEY (id),

  -- §4.3: một delivery một row outbox. Đây cũng là neo mà redrive/repair dùng để reset thay
  -- vì chèn row mới (FR-004).
  CONSTRAINT mail_outbox_delivery_id_unique UNIQUE (delivery_id),

  -- Row outbox không thể tồn tại độc lập với message nó đại diện; RESTRICT chặn vô tình xoá
  -- message khi còn outbox row.
  CONSTRAINT mail_outbox_delivery_id_fkey FOREIGN KEY (delivery_id)
    REFERENCES mail_messages (delivery_id) ON DELETE RESTRICT ON UPDATE RESTRICT,

  -- §6.2: `pending → publishing → published | failed`.
  CONSTRAINT mail_outbox_status_check CHECK (
    status IN ('pending', 'publishing', 'published', 'failed')
  ),

  -- Generation phải khớp với `mail_messages.dispatch_generation` của cùng delivery khi row
  -- được tạo hoặc được redrive reset. Không có cross-row CHECK trong SQLite, nên tính khớp
  -- nhau do conditional UPDATE của repository enforce.
  CONSTRAINT mail_outbox_dispatch_generation_check CHECK (dispatch_generation >= 1),

  -- Chu kỳ publish hiện tại: chỉ tăng khi thử lại, reset về 0 khi re-enqueue.
  CONSTRAINT mail_outbox_publish_attempts_check CHECK (publish_attempts >= 0),

  -- `available_at` là earliest time row được claim; publish retry đẩy nó ra sau theo backoff.
  CONSTRAINT mail_outbox_available_at_check CHECK (available_at > 0),

  -- Tính nhất quán cặp lease: cùng null hoặc cùng có. `publishing` không có lease là trạng
  -- thái hỏng; `pending` có lease cũng vậy. Repository ghi cả hai hoặc xoá cả hai.
  CONSTRAINT mail_outbox_lease_pair_check CHECK ((claimed_at IS NULL) = (claimed_by IS NULL)),

  -- Không cho định danh rỗng (chống bug ghi key rỗng im lặng).
  CONSTRAINT mail_outbox_id_non_empty_check CHECK (id <> ''),
  CONSTRAINT mail_outbox_delivery_id_non_empty_check CHECK (delivery_id <> ''),

  -- `last_error` chỉ ghi error code/token đã sanitize (§4.2, NFR-001) — không lưu recipient,
  -- nội dung render, credential hay raw payload Queue.
  CONSTRAINT mail_outbox_last_error_format_check CHECK (
    last_error IS NULL OR length(last_error) > 0
  )
);

-- §4.3: index claim theo `(status, available_at)` — đường quét chính của publisher.
CREATE INDEX mail_outbox_status_available_idx ON mail_outbox (status, available_at);

-- §6.2: lease reclaim theo `claimed_at` quá cũ — đường thứ hai của publisher, tách index
-- riêng vì predicate khác hẳn (`claimed_at <= cutoff` chứ không phải `available_at <= now`).
CREATE INDEX mail_outbox_status_claimed_idx ON mail_outbox (status, claimed_at);

-- §6.2.2: reconciler quét dispatch-incomplete theo trạng thái + tuổi bản ghi.
CREATE INDEX mail_outbox_status_updated_idx ON mail_outbox (status, updated_at);
