-- 0002_push_delivery_outbox.sql — schema "delivery" của D1 `push`: Push Notification,
-- Push Delivery, transactional outbox, và bảng idempotency của API.
--
-- Nguồn: docs/applications/push-notification/01-architecture.md §5.4 (Notification),
--        §5.6 (Delivery state + lease/fencing + guarded conditional write),
--        §6.1 (outbox model + predicate claim + chống dồn intent), §6.2 (publisher),
--        §6.3 (envelope 7 field — payload materialize tại control plane), §7 (delivery
--        idempotency), §8.1 (claim/release/outcome/invalidate);
--        docs/applications/push-notification/02-requirements.md FR-008 (API idempotency +
--        Expiry + payload budget), FR-012 (delivery creation), FR-013 (outbox + envelope),
--        FR-015 (state machine), FR-021 (rate limit);
--        docs/applications/push-notification/03-operations.md §4.2 (c) (decision table a1–a6),
--        §8 (index bắt buộc).
--
-- ⚠️ **Payload KHÔNG nằm ở `push_deliveries` và cũng không nằm ở `push_outbox`.** §6.3 nói
-- payload được materialize ở control plane **trong transaction đã commit**, và envelope Queue
-- chứa payload là nguồn sự thật duy nhất khi worker gửi. Schema này đặt payload làm **một**
-- cột `payload_json` trên `push_notifications` — nguồn của envelope cho **mọi** delivery của
-- notification đó — thay vì nhân bản nó trên từng delivery và từng outbox record. Ba lý do,
-- cùng một nguyên tắc "một nguồn sự thật":
--   1. Nhân bản payload ở N bảng tạo N cơ hội lệch nội dung giữa các delivery của cùng một
--      notification, và tài liệu không mô tả cách chọn "bản nào đúng" khi chúng lệch.
--   2. `push_outbox` cố ý chỉ tham chiếu `delivery_id` (§6.1: "`delivery_id` là tham chiếu
--      duy nhất từ outbox record tới logical delivery"), nên đặt payload ở đó sẽ **vi phạm**
--      câu chữ đó.
--   3. Retention của payload theo notification, không theo outbox attempt: một delivery có
--      thể có nhiều outbox record (republish §5.6.3) và payload không nên bị nhân bản/lưu lâu
--      hơn mức cần thiết (FR-008, `03-operations.md` §13).
--
-- Delivery material cho runtime (`endpoint`, `p256dh`, `auth`, credential provider) **không**
-- nằm ở hai bảng này: nó được **join** lúc claim từ `push_subscriptions`/`push_provider_credentials`
-- qua `subscription_id`/`provider_id`, và chỉ được trả trong response `200` của claim
-- (`01-architecture.md` §8.1).

CREATE TABLE push_notifications (
  notification_id TEXT NOT NULL,
  app TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  -- Canonical serialization của `payload` (FR-013): UTF-8 JSON của đúng bốn khoá
  -- `title`/`body`/`url`/`data`, thứ tự cố định, không whitespace thừa. Đây là **nguồn duy
  -- nhất** để dựng envelope Queue và để đối chiếu `payload_digest` của claim (§8.1).
  -- KHÔNG chứa credential, token hay PII ngoài phạm vi hiển thị (FR-008).
  payload_json TEXT NOT NULL,
  -- Số octet UTF-8 của `payload_json`; lưu lại để audit/metric ngân sách byte (FR-008)
  -- mà không phải serialize lại, và để chứng minh ngân sách đã áp **trước** khi persist.
  payload_bytes INTEGER NOT NULL,
  -- Hạn **nghiệp vụ** của notification (FR-008), KHÁC Web Push transport TTL. Claim predicate
  -- và decision table a1 của reconciliation đều so mốc này.
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT push_notifications_pkey PRIMARY KEY (notification_id),
  CONSTRAINT push_notifications_notification_id_non_empty_check CHECK (notification_id <> ''),

  -- `app` đến từ authenticated principal (§8.2, FR-019), không phải body value tùy ý.
  CONSTRAINT push_notifications_app_non_empty_check CHECK (app <> ''),

  -- `principal_id` là **định danh ổn định** của caller đã xác thực, không phải giá trị
  -- header tự khai (FR-008 nêu rõ điểm này khi mở rộng scope idempotency so với mail).
  CONSTRAINT push_notifications_principal_id_non_empty_check CHECK (principal_id <> ''),

  -- Ngân sách plaintext FR-008: trần **3993** octet (4096 − 103 framing của AES128GCM).
  -- CHECK này là chốt chặn cuối ở tầng database cho trường hợp một writer khác (script vận
  -- hành, migration sau) ghi vượt ngân sách mà không đi qua validator của use case.
  CONSTRAINT push_notifications_payload_bytes_check CHECK (
    payload_bytes >= 0 AND payload_bytes <= 3993
  )
);

CREATE TABLE push_deliveries (
  delivery_id TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  app TEXT NOT NULL,
  transport TEXT NOT NULL,
  -- FR-012: delivery được tạo ở `pending` — routing xảy ra TRƯỚC enqueue, nên lúc commit
  -- chưa có message nào trong Queue. `queued` chỉ có sau `Queue.send()` thành công
  -- (`01-architecture.md` §6.2, actor duy nhất là Outbox Publisher).
  status TEXT NOT NULL DEFAULT 'pending',
  dispatch_generation INTEGER NOT NULL DEFAULT 0,
  -- Lease: chỉ được cấp bởi atomic claim (§5.6), control plane quản lý, worker chỉ đọc.
  lease_expires_at INTEGER,
  -- Trùng với `push_notifications.expires_at` **có chủ ý**: predicate claim chạy trên
  -- `push_deliveries` (`AND expires_at > :now`, §8.1), và decision table a1 của
  -- reconciliation quét `push_deliveries(expires_at)`. Ghi trùng ở đây giữ predicate nằm
  -- trong **một** statement không cần join; hai cột được ghi trong **cùng** `db.batch()`
  -- nên không thể lệch nhau. Đây là denormalization **có guard**: use case tạo notification
  -- luôn ghi cùng một mốc vào cả hai bảng.
  expires_at INTEGER NOT NULL,
  -- `expired_at` chỉ được set bởi reconciliation (c) a1 — actor duy nhất của `→ expired`
  -- (`01-architecture.md` §5.6).
  expired_at INTEGER,
  delivered_at INTEGER,
  failed_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT push_deliveries_pkey PRIMARY KEY (delivery_id),

  -- FR-015: state đóng 7 giá trị. Đây là **nguồn duy nhất** của vocabulary state ở tầng
  -- database: một transition ghi vào giá trị ngoài đây bị D1 từ chối.
  CONSTRAINT push_deliveries_status_check CHECK (
    status IN ('pending', 'queued', 'processing', 'delivered', 'failed', 'expired', 'cancelled')
  ),

  -- §4.2: `Transport` là `web`/`app`; `web-push` là provider **type**, không phải transport.
  CONSTRAINT push_deliveries_transport_check CHECK (transport IN ('web', 'app')),

  -- §5.6: `dispatch_generation` tăng đơn diệu, tính trong chính statement claim
  -- (`dispatch_generation + 1`). 0 = chưa từng claim; CHECK `>= 0` chứ không `>= 1`.
  CONSTRAINT push_deliveries_dispatch_generation_check CHECK (dispatch_generation >= 0),

  CONSTRAINT push_deliveries_delivery_id_non_empty_check CHECK (delivery_id <> ''),
  CONSTRAINT push_deliveries_notification_id_non_empty_check CHECK (notification_id <> ''),
  CONSTRAINT push_deliveries_subscription_id_non_empty_check CHECK (subscription_id <> ''),
  CONSTRAINT push_deliveries_provider_id_non_empty_check CHECK (provider_id <> ''),
  CONSTRAINT push_deliveries_app_non_empty_check CHECK (app <> ''),

  -- Tính nhất quán cặp lease: `processing` **nghĩa là** "đang giữ lease" (§5.6), nên
  -- `status = 'processing' ⇔ lease_expires_at IS NOT NULL`. Biểu diễn được **và** không chặn
  -- transition hợp lệ:
  --   - `claim` ghi `processing` + `lease_expires_at` trong **cùng** statement;
  --   - `release` ghi `queued` + `lease_expires_at = NULL` trong **cùng** statement;
  --   - `outcome` ghi terminal + `lease_expires_at = NULL` trong **cùng** statement;
  --   - reconciliation a1 ghi `expired` + `lease_expires_at = NULL` cùng statement.
  -- Vì vậy cột này **không** cần câu note "không biểu diễn được".
  CONSTRAINT push_deliveries_lease_parity_check CHECK (
    (status = 'processing') = (lease_expires_at IS NOT NULL)
  ),

  -- `processing ⇔ dispatch_generation >= 1` — execution đang giữ lease **phải** có fencing
  -- token; `processing` với `dispatch_generation = 0` là một execution giữ lease mà không có
  -- token để chứng minh nó là chủ sở hữu, và đó là lớp lỗi nguy hiểm nhất của cơ chế này.
  --
  -- ⚠️ **Chiều ngược lại là CỐ Ý vắng mặt.** `queued` **không** đòi `dispatch_generation = 0`:
  -- `release` ghi `processing → queued` mà **không** đổi generation
  -- (`01-architecture.md` §8.1: "dispatch_generation KHÔNG đổi"), và `release` lặp lại trên một
  -- delivery đã release là một no-op idempotent. Nên một hàng `queued` hợp lệ có thể mang
  -- generation bất kỳ `>= 0`. Viết CHECK đối xứng (`(status = 'processing') = (dispatch_generation >= 1)`)
  -- sẽ vi phạm chính transition đó — và vì CHECK của D1 là **fail**, nó làm `release` ném
  -- `SQLITE_CONSTRAINT_CHECK` thay vì trả row, biến một transition hợp lệ thành một 500.
  -- Vì vậy CHECK này là **một chiều**: bắt lỗi nguy hiểm, không cấm trạng thái hợp lệ.
  CONSTRAINT push_deliveries_generation_claim_parity_check CHECK (
    status <> 'processing' OR dispatch_generation >= 1
  ),

  -- Mốc đánh dấu terminal khớp state: `expired` ⇔ `expired_at NOT NULL`. `delivered`/`failed`
  -- có cột riêng nên **không** gộp vào CHECK này (transition `expired → delivered` không tồn
  -- tại, nhưng gộp sẽ chặn vô ích một transition hợp lệ).
  CONSTRAINT push_deliveries_expired_at_parity_check CHECK (
    (status = 'expired') = (expired_at IS NOT NULL)
  )
);

-- FR-013 / §6.1: `Outbox Entry` — record durable của một `Delivery Command` cần publish vào
-- Queue. Ghi trong **cùng** `db.batch()` với notification + delivery + idempotency record.
CREATE TABLE push_outbox (
  outbox_id TEXT NOT NULL,
  -- §6.1: "`delivery_id` là tham chiếu duy nhất từ outbox record tới logical delivery" —
  -- vì vậy bảng này KHÔNG có `notification_id` và không mang payload (xem header file).
  delivery_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  claimed_at INTEGER,
  -- Lease của outbox claim (§6.1: publisher giữ lease hạn định, crash → lease hết hạn →
  -- claim lại). Chỉ được ghi bởi guarded UPDATE của claim.
  lease_expires_at INTEGER,
  claimed_by TEXT,
  published_at INTEGER,
  -- §4.1: nhìn `last_error` là bước đầu của việc điều tra một record `failed`. Nó **chỉ**
  -- chứa error đã sanitize (mã lớp lỗi), **không** phải response body của Queue/provider
  -- — Queue send failure không mang payload, nhưng một message lỗi bất kỳ có thể chứa
  -- context, nên schema **không** bound được nội dung; đó là trách nhiệm của writer, và
  -- CHECK ở đây giữ trần độ dài để một log lỗi vô tình không phình cột này vô hạn.
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT push_outbox_pkey PRIMARY KEY (outbox_id),

  -- §6.1: `pending` → `publishing` → `published` (terminal) | `failed` (recoverable, **không**
  -- claimable — chỉ operator mới đưa nó về đường publish qua `republish`, §4.3).
  CONSTRAINT push_outbox_status_check CHECK (
    status IN ('pending', 'publishing', 'published', 'failed')
  ),

  CONSTRAINT push_outbox_attempts_check CHECK (attempts >= 0),
  CONSTRAINT push_outbox_outbox_id_non_empty_check CHECK (outbox_id <> ''),
  CONSTRAINT push_outbox_delivery_id_non_empty_check CHECK (delivery_id <> ''),

  -- Tính nhất quán cặp lease: `publishing` ⇔ giữ lease. `claimed_by`/`claimed_at` đi cùng
  -- `lease_expires_at` vì §6.1 nói mọi thao tác ghi của publisher mang `claimed_by`/`claimed_at`
  -- của lần claim hiện tại — một lease không có owner là state không tồn tại.
  CONSTRAINT push_outbox_lease_pair_check CHECK (
    (lease_expires_at IS NULL) = (claimed_by IS NULL)
  ),
  CONSTRAINT push_outbox_publishing_lease_check CHECK (
    (status = 'publishing') = (lease_expires_at IS NOT NULL)
  ),

  -- `published` ⇔ `published_at NOT NULL`: `published` là **bằng chứng duy nhất** rằng một
  -- Queue message đã tồn tại cho delivery (`01-architecture.md` §6.2).
  CONSTRAINT push_outbox_published_at_parity_check CHECK (
    (status = 'published') = (published_at IS NOT NULL)
  ),

  CONSTRAINT push_outbox_last_error_length_check CHECK (
    last_error IS NULL OR length(last_error) <= 512
  )
);

-- FR-008: idempotency record của `POST /v1/notifications`.
--
-- ⚠️ `idempotency_retention` **không có cột nào ở đây** và không được khởi tạo bởi
-- implementation: đó là launch gate của service owner (`FR-008`, `03-operations.md` §11, §13).
-- Ba điều kiện xoá an toàn — mọi delivery terminal · không còn outbox record
-- `pending`/`publishing` · `now > created_at + idempotency_retention` — được **cleanup job**
-- kiểm bằng truy vấn, không phải bằng trigger: trigger chạy trong D1 không có quyền đọc bảng
-- khác một cách đáng tin cậy, và điều kiện (i)/(ii) là điều kiện nhiều bảng.
CREATE TABLE notification_idempotency (
  app TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  -- FR-008: `Idempotency-Key` **bắt buộc**, `MUST` ≤ 128 ký tự. CHECK ở đây là chốt chặn
  -- cuối ở tầng database cho trường hợp writer khác ghi key quá dài.
  idempotency_key TEXT NOT NULL,
  -- Hash canonical của request. Replay cùng key + cùng hash → `200` cùng `notification_id`;
  -- cùng key + hash khác → `409` (không trả `notification_id` của lần trước).
  request_hash TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  -- FR-008: scope là **đúng** `(app, principal_id, idempotency_key)`. Hai caller khác
  -- principal dùng cùng key **không** dedupe lẫn nhau, và một caller **không** chiếm được
  -- key của caller khác. Đây là guard chống đua đồng thời: hai request cùng key tới cùng
  -- lúc thì unique constraint bảo đảm chỉ **một** notification được tạo.
  CONSTRAINT notification_idempotency_pkey PRIMARY KEY (app, principal_id, idempotency_key),

  CONSTRAINT notification_idempotency_key_length_check CHECK (length(idempotency_key) <= 128),
  CONSTRAINT notification_idempotency_key_non_empty_check CHECK (idempotency_key <> ''),
  CONSTRAINT notification_idempotency_app_non_empty_check CHECK (app <> ''),
  CONSTRAINT notification_idempotency_principal_non_empty_check CHECK (principal_id <> ''),
  CONSTRAINT notification_idempotency_request_hash_non_empty_check CHECK (request_hash <> ''),
  CONSTRAINT notification_idempotency_notification_id_non_empty_check CHECK (
    notification_id <> ''
  )
);

-- Index cho các đường truy vận canonical. Mỗi index có comment nêu **mục đích** — `§8`
-- yêu cầu index là *structural*, không phải tuning.

-- ⚠️ **Index bắt buộc của §8**: partial unique trên `delivery_id` khi record đang chờ
-- publish. Đây là **guard chống dồn intent ở tầng database** (§6.1, `03-operations.md` §8) —
-- thứ chặn hai reconciler (hoặc hai lời gọi `republish`) chạy đồng thời cùng tạo intent, vì
-- application-level read-then-write không đủ. Record `published`/`failed` **không** nằm
-- trong index nên một intent mới vẫn hợp lệ sau khi record cũ terminal.
CREATE UNIQUE INDEX push_outbox_one_open_intent ON push_outbox (delivery_id)
  WHERE status IN ('pending', 'publishing');

-- ⚠️ **Index bắt buộc của §8**: `(status, available_at)` cho outbox claim predicate
-- `status = 'pending' AND available_at <= :now OR (status = 'publishing' AND
-- lease_expires_at <= :now)`.
CREATE INDEX push_outbox_claim_idx ON push_outbox (status, available_at);

-- Nhánh `publishing` của claim predicate: lease hết hạn thì claim lại (§6.1).
CREATE INDEX push_outbox_publishing_lease_idx ON push_outbox (status, lease_expires_at);

-- ⚠️ **Index bắt buộc của §8**: `push_deliveries (expires_at)` để logical delivery
-- reconciliation (c) quét được delivery non-terminal quá hạn mà không full-scan
-- (`03-operations.md` §4.2, decision a1).
CREATE INDEX push_deliveries_expires_at_idx ON push_deliveries (expires_at);

-- Truy vết delivery theo notification (§7: `notification_id → delivery_id → …`) và
-- điều kiện xoá idempotency record FR-008 (i): "mọi delivery của notification đã terminal".
CREATE INDEX push_deliveries_notification_idx ON push_deliveries (notification_id, status);

-- Đường list delivery theo `(app, transport)` của Admin API + metric `provider_id`.
CREATE INDEX push_deliveries_app_transport_idx ON push_deliveries (app, transport);

-- Decision table a2/a4 của reconciliation (c): "delivery `queued`/không còn open intent" —
-- đường quét cần subscription + provider hiện tại của delivery đó.
CREATE INDEX push_deliveries_subscription_idx ON push_deliveries (subscription_id, status);
CREATE INDEX push_deliveries_provider_idx ON push_deliveries (provider_id, status);