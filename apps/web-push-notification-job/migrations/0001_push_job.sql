-- 0001_push_job.sql — schema D1 `push-job`: job execution state của chính
-- `web-push-notification-job`.
--
-- Nguồn: docs/applications/web-push-notification-job/01-architecture.md §11b (bốn nhóm bắt buộc),
--        02-requirements.md FR-022; docs/applications/web-push-notification-job/03-operations.md
--        §14.10 (job reconciliation), §14.11 (crash windows W1–W4).
--
-- ⚠️ Bốn nhóm FR-022 được biểu diễn bằng **hai** bảng, và đó là quyết định có chủ đích:
--
--   1. `push_jobs`           → (2) processed marker + (3) envelope của lần consume đầu
--                              + (4) reconciliation data (`last_consumed_at`, `consume_count`,
--                              `processed`, `terminal_outcome`). Một row cho mỗi `delivery_id`.
--   2. `push_job_attempts`   → (1) attempt record, idempotent theo `(delivery_id, attempt)`
--                              bằng UNIQUE. Tách riêng vì một delivery có **nhiều** attempt,
--                              và phím idempotency của nhóm (1) là **cặp** chứ không phải
--                              `delivery_id` — đặt UNIQUE trên `push_jobs` sẽ chặn attempt thứ hai.
--
-- ⚠️ `push_jobs.payload_json` là **payload đã materialize ở control plane**, không phải nội dung
-- do worker sinh ra. Đây là thứ **duy nhất** cho phép job reconciliation dựng lại chính xác
-- envelope bất biến ban đầu để re-deliver khi message Queue đã biến mất sau retention
-- (FR-022 nhóm 3). Ghi nó là JSON **text** chứ không phải 4 cột riêng: envelope là **một** đối
-- tượng JSON của 7 field, và tách nó ra làm cột sẽ tạo ra một schema thứ hai phải đồng bộ khi
-- FR-013 evolve.
--
-- ⚠️ **KHÔNG có cột nào cho credential, `auth`, `p256dh`, VAPID key hay header authorization.**
-- Đó là ràng buộc của FR-022 nhóm 3 và SR-001, và nó là ràng buộc **cấu trúc**: không có cột
-- nào để ghi vào, nên một lỗi ghi secret không chỉ là policy bị phá mà còn không biên dịch được
-- mà không sửa schema. CHECK bên dưới chốt khoá top-level của envelope lưu để một hàng hỏng do
-- migration/bug ghi không tạo ra một envelope mang secret — và consumer vẫn validate lại trước
-- khi re-deliver (`job-reconciliation.ts`), nên đây là **hai** lớp phòng thủ độc lập.
--
-- Mọi constraint có tên theo convention của repo (`CONSTRAINT <table>_<rule>_check`): trên
-- SQLite/D1, constraint có tên là chính thông điệp lỗi, nên đọc được ngay khi debug và
-- migration sau tham chiếu được mà không phải rebuild bảng.

CREATE TABLE push_jobs (
  delivery_id TEXT NOT NULL,
  -- Envelope của lần consume **đầu tiên** — 7 field §5, `payload` nằm trong `payload_json`.
  envelope_version INTEGER NOT NULL,
  notification_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  transport TEXT NOT NULL,
  payload_json TEXT NOT NULL,

  -- (4) reconciliation data: số lần consume đã thấy, và mốc để sweep tính "đã nhận nhưng quá
  -- ngưỡng chưa kết thúc". `last_consumed_at` được **chạm** ở mỗi lần bắt đầu xử lý, nên
  -- sweep không cần một cột riêng cho "đã persist nhưng chưa ack" — job đó chính là job có
  -- `processed = 0` và `last_consumed_at` cũ.
  consume_count INTEGER NOT NULL DEFAULT 1,
  last_consumed_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL,

  -- (2) processed marker. Marker là thứ cho phép skip redelivery, nên nó được đặt **sau khi**
  -- state cần thiết đã persist (pipeline: sau outcome/invalidate, hoặc sau no-op hợp lệ).
  processed INTEGER NOT NULL DEFAULT 0,
  terminal_outcome TEXT,

  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT push_jobs_pkey PRIMARY KEY (delivery_id),

  -- Enum đóng cho `transport` — vocabulary của FR-013, không phải provider type.
  CONSTRAINT push_jobs_transport_check CHECK (transport IN ('web', 'app')),

  -- Enum đóng cho kết cục đã persist. KHÔNG có `expired`/`cancelled` là terminal state của
  -- control plane; `expired` ở đây là kết cục **của job** (worker không gửi provider vì đã hết
  -- hạn), và nó không phải delivery state.
  CONSTRAINT push_jobs_terminal_outcome_check CHECK (
    terminal_outcome IS NULL OR terminal_outcome IN ('delivered', 'failed', 'expired')
  ),

  -- Parity: có marker ⇔ có kết cục. Một marker không có kết cục là một row mà reconciliation
  -- không biết có re-deliver hay không.
  CONSTRAINT push_jobs_processed_parity_check CHECK (
    (processed = 1) = (terminal_outcome IS NOT NULL)
  ),

  CONSTRAINT push_jobs_envelope_version_check CHECK (envelope_version >= 1),
  CONSTRAINT push_jobs_consume_count_check CHECK (consume_count >= 1),
  CONSTRAINT push_jobs_processed_check CHECK (processed IN (0, 1)),

  -- identifier rỗng là bug ghi key rỗng im lặng; chặn ở schema thay vì ở application.
  CONSTRAINT push_jobs_delivery_id_non_empty_check CHECK (delivery_id <> ''),
  CONSTRAINT push_jobs_notification_id_non_empty_check CHECK (notification_id <> ''),
  CONSTRAINT push_jobs_subscription_id_non_empty_check CHECK (subscription_id <> ''),
  CONSTRAINT push_jobs_provider_id_non_empty_check CHECK (provider_id <> ''),

  -- `payload_json` phải parse được và phải là object JSON. Đây là hàng phòng thủ đầu tiên
  -- cho "job state là nguồn re-deliver": một `payload_json` hỏng sẽ bị chặn ở **ghi** thay vì
  -- chỉ lộ ra khi sweep đọc. `json_valid` là hàm có sẵn của SQLite (D1 dùng SQLite).
  -- ⚠️ CHECK này được kiểm **trước** trigger ở dưới: `WHEN` của trigger có điều kiện
  -- `json_valid`, nên một `payload_json` hỏng không tới được trigger — và thông báo lỗi là
  -- của CHECK này, đúng như tên constraint muốn nói.
  CONSTRAINT push_jobs_payload_is_json_object_check CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  )
);

-- Cấm khoá secret ở **top-level** của envelope lưu. `json_each` duyệt key của object gốc;
-- khoá lồng trong `payload.data` không bị chặn ở đây (đó là dữ liệu opaque của App) — và
-- consumer validate lại toàn envelope bằng validator canonical trước khi re-deliver.
--
-- ⚠️ **Vì sao đây là TRIGGER chứ không phải `CONSTRAINT ... CHECK`.** SQLite (nền của D1)
-- **cấm subquery trong `CHECK`**: một `NOT EXISTS (SELECT ... FROM json_each(...))` làm cả
-- `CREATE TABLE` fail với `subqueries prohibited in CHECK constraints`, tức hàng phòng thủ
-- đó biến thành **bảng không tồn tại**. Trigger là hình thức hợp lệ duy nhất để dùng
-- `json_each` tại thời điểm ghi. (Đo trực tiếp trên SQLite: bản CHECK subquery fail ngay
-- lúc apply migration — đây không phải suy đoán.)
--
-- ⚠️ `WHEN` có `json_valid(...) AND json_type(...) = 'object'`: CHECK phía trên đã loại
-- `payload_json` hỏng trước khi trigger chạy, và điều kiện này làm trigger **tự bảo vệ** nếu
-- ai đó sau này bỏ CHECK đi — `json_each` ném `malformed JSON`, biến một lỗi dữ liệu thành
-- một lỗi hạ tầng khó chẩn đoán.
--
-- ⚠️ `RAISE(ABORT, 'CHECK constraint failed: push_jobs_envelope_forbidden_key_check')` dùng
-- **đúng** thông điệp của một CHECK vì trên SQLite/D1 tên constraint chính là thông điệp lỗi —
-- đó là thứ test và operator đọc để biết quy tắc nào đã bị vi phạm. Cần **hai** trigger
-- (`INSERT` và `UPDATE`) vì một trigger không bắt được loại write còn lại.
CREATE TRIGGER push_jobs_envelope_forbidden_key_guard
BEFORE INSERT ON push_jobs
WHEN json_valid(NEW.payload_json)
 AND json_type(NEW.payload_json) = 'object'
 AND EXISTS (
  SELECT 1 FROM json_each(NEW.payload_json) AS field
  WHERE field.key IN (
    'auth', 'p256dh', 'vapid_private_key', 'vapid_public_key',
    'private_key', 'public_key', 'credential', 'credentials',
    'provider_credential', 'subscription', 'provider'
  )
 )
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint failed: push_jobs_envelope_forbidden_key_check');
END;

CREATE TRIGGER push_jobs_envelope_forbidden_key_guard_update
BEFORE UPDATE ON push_jobs
WHEN json_valid(NEW.payload_json)
 AND json_type(NEW.payload_json) = 'object'
 AND EXISTS (
  SELECT 1 FROM json_each(NEW.payload_json) AS field
  WHERE field.key IN (
    'auth', 'p256dh', 'vapid_private_key', 'vapid_public_key',
    'private_key', 'public_key', 'credential', 'credentials',
    'provider_credential', 'subscription', 'provider'
  )
 )
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint failed: push_jobs_envelope_forbidden_key_check');
END;

-- Đường truy vấn canonical của job reconciliation (FR-022 nhóm 4): quét job **chưa** có
-- processed marker mà `last_consumed_at` đã cũ. Partial index vì sweep **chỉ** hỏi đúng vế
-- này — một index toàn bảng sẽ phải đọc cả các job đã xong.
CREATE INDEX push_jobs_stuck_idx
  ON push_jobs (last_consumed_at)
  WHERE processed = 0;

-- (1) attempt record — idempotent theo `(delivery_id, attempt)`.
--
-- `attempt` là `message.attempts` của **Queue**, không phải bộ đếm nội bộ của worker: hai
-- execution cùng consume cùng một message phải ghi cùng một phím, và một bộ đếm tự tăng sẽ
-- cho hai phím khác nhau — biến idempotency thành tranh chấp. UNIQUE dưới đây là thứ **bắt**
-- việc đó, và `INSERT OR IGNORE` ở repository biến nó thành no-op đúng nghĩa.
--
-- `phase` là thứ phân biệt "chắc chắn chưa tới provider" (`before_send`, `no_provider_call`,
-- `not_sent`) với "có thể đã tới" (`after_send`, `terminal_sent`) — nhóm (ii) vs (iii) của §12,
-- mà docs yêu cầu phải **quan sát được trong job state** chứ không chỉ trong log.
CREATE TABLE push_job_attempts (
  delivery_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,

  -- Kết cục đã sanitize, tập đóng. KHÔNG lưu raw error body của provider: body có thể mang
  -- endpoint phản chiếu (SR-002, docs §6 của operations).
  outcome TEXT NOT NULL,
  phase TEXT NOT NULL,
  http_status INTEGER,
  retry_after_ms INTEGER,

  -- Trạng thái của chính attempt: `open` cho tới khi pipeline đóng nó. `open` là thứ sweep
  -- nhìn thấy cho "việc đã nhận nhưng chưa kết thúc".
  state TEXT NOT NULL DEFAULT 'open',
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT push_job_attempts_pkey PRIMARY KEY (delivery_id, attempt),

  CONSTRAINT push_job_attempts_outcome_check CHECK (
    outcome IN (
      'consumed', 'delivered', 'failed', 'retrying', 'skipped',
      'contract_violation', 'runtime_unavailable', 'expired_before_send'
    )
  ),

  -- Phân biệt hai nhóm retryable của §12 phải **đọc được từ D1**, không chỉ từ log.
  CONSTRAINT push_job_attempts_phase_check CHECK (
    phase IN ('not_sent', 'before_send', 'after_send', 'terminal_sent', 'no_provider_call')
  ),

  CONSTRAINT push_job_attempts_state_check CHECK (state IN ('open', 'completed')),
  CONSTRAINT push_job_attempts_attempt_check CHECK (attempt >= 0),

  -- http_status chỉ có khi đi qua HTTP; `null` cho lỗi không qua provider.
  CONSTRAINT push_job_attempts_http_status_check CHECK (http_status IS NULL OR http_status > 0),
  CONSTRAINT push_job_attempts_retry_after_check CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),

  -- Một attempt có state thì không được để trống hai mốc thời gian: `started_at` là NOT NULL
  -- rồi, và `updated_at` có default — nhưng hai mốc phải **thứ tự đúng** để tuổi attempt
  -- tính được.
  CONSTRAINT push_job_attempts_time_order_check CHECK (updated_at >= started_at)
);

-- Đường đọc "attempt gần nhất của delivery" cho pipeline và cho dashboard "việc kẹt".
CREATE INDEX push_job_attempts_recent_idx
  ON push_job_attempts (delivery_id, attempt DESC);

-- Attempt đang mở (chưa kết thúc) — chính là crash window W2/W3: provider có thể đã nhận và
-- job chưa ghi được kết quả.
CREATE INDEX push_job_attempts_open_idx
  ON push_job_attempts (started_at)
  WHERE state = 'open';