-- 0001_push_core.sql — schema "identity + configuration" của D1 `push`: Device, Push
-- Subscription, Push Provider (+ credential, app mapping), Routing Policy, Audit.
--
-- Nguồn: docs/applications/push-notification/01-architecture.md §5.1 (Device), §5.2
--        (Subscription), §5.3 (Provider + disable semantics + provider selection),
--        §5.5 (Transport Priority), §9 (ba loại secret), §11 (correlation), §12 (ownership);
--        docs/applications/push-notification/02-requirements.md FR-001 (app isolation),
--        FR-002 (device), FR-003 (endpoint validation), FR-004 (subscription lifecycle),
--        FR-005/FR-007 (provider scope per app), FR-006 (credential + key rotation),
--        FR-017/FR-019/FR-020 (admin API, auth, audit);
--        docs/applications/push-notification/03-operations.md §6.1, §6.5 (hold),
--        §7.2 (VAPID rotation theo `vapid_key_id`), §8 (inventory + index bắt buộc).
--
-- Mọi timestamp là **epoch millis INTEGER** (`CAST(unixepoch('subsec') * 1000 AS INTEGER)` là
-- mặc định của cột created/updated). Không có cột nào lưu raw `endpoint` dạng secret hơn bản
-- chuẩn, và **không** có cột nào lưu credential ở dạng plaintext: `credential_ciphertext` là
-- BLOB đã mã hoá bằng root key, kèm `credential_encryption_version` (FR-006).
--
-- Mọi constraint được đặt tên theo convention của repo
-- (`CONSTRAINT <table>_<rule>_check`) để thông báo lỗi của SQLite/D1 đọc được ngay.
--
-- ⚠️ `push_routing_policy` là bảng **có hàng** (seed theo `App`) chứ không phải bảng rỗng chờ
-- điền: routing là điều kiện của correctness (mọi App cần một policy để route), nên
-- application tạo notification chỉ route được khi có hàng policy. Đây là lựa chọn
-- implementation; `Transport Priority` v1 cố định `app > web`
-- (`01-architecture.md` §5.5) nên policy chỉ cần một cột thứ tự ưu tiên để mở đường cho
-- priority/fallback ở phase sau mà không phải đổi schema.

CREATE TABLE devices (
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app TEXT NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT devices_pkey PRIMARY KEY (device_id),

  -- FR-002: device identity là logical, KHÔNG suy luận bằng IP/User-Agent — vì vậy khóa
  -- chính là `device_id` do client sinh, không phải một hash của fingerprint nào.
  CONSTRAINT devices_device_id_non_empty_check CHECK (device_id <> ''),
  CONSTRAINT devices_user_id_non_empty_check CHECK (user_id <> ''),

  -- FR-001: `app` là namespace cô lập; `devices(app, user_id)` phục vụ đường
  -- "resolve users → devices" của routing (`01-architecture.md` §5.5).
  CONSTRAINT devices_app_non_empty_check CHECK (app <> '')
);

-- FR-002: một `Device` có thể có **nhiều** `Push Subscription` thuộc các `Transport`
-- khác nhau (§5.1) — nên đây là unique theo endpoint, KHÔNG phải theo (device, transport).
-- `endpoint` là chuỗi dài nên `endpoint_hash` mới là khoá thực thi; `endpoint` là dữ liệu
-- tham chiếu để tái validate theo định kỳ (FR-003) và là **không phải** label metric.
CREATE TABLE push_subscriptions (
  subscription_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  app TEXT NOT NULL,
  transport TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  endpoint_hash TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- FR-006 / §7.2: subscription **MUST** lưu `vapid_key_id` dùng lúc tạo; worker ký theo
  -- key của subscription, không phải "key hiện tại của App".
  vapid_key_id TEXT NOT NULL,
  provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  disabled_reason TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT push_subscriptions_pkey PRIMARY KEY (subscription_id),

  CONSTRAINT push_subscriptions_transport_check CHECK (transport IN ('web', 'app')),

  -- FR-004: vocabulary đóng `active`/`disabled`/`expired`; chỉ `active` đủ điều kiện tạo
  -- delivery. Đây cũng là vocabulary mà ack của `invalidate` dùng (`§8.1`).
  CONSTRAINT push_subscriptions_status_check CHECK (status IN ('active', 'disabled', 'expired')),

  -- `disabled_reason` chỉ lưu **mã** nguyên nhân đã sanitize (tập
  -- `SUBSCRIPTION_DISABLE_CAUSE` của domain), không lưu response body của provider.
  CONSTRAINT push_subscriptions_disabled_reason_check CHECK (
    disabled_reason IS NULL OR disabled_reason IN (
      'user_unregister', 'admin_disable', 'provider_invalidation',
      'endpoint_revalidation_failed'
    )
  ),

  -- Tính nhất quán: subscription đóng thì **phải** có lý do disable; `active` thì không.
  -- Đây là điều kiện biểu diễn được mà không chặn transition hợp lệ: cả hai nhánh
  -- (`active → disabled`, idempotent trên `disabled`) đều ghi cặp này cùng nhau.
  CONSTRAINT push_subscriptions_status_reason_parity_check CHECK (
    (status = 'active') = (disabled_reason IS NULL)
  ),

  -- Chặn trùng endpoint: FR-003 "tránh tạo subscription trùng không cần thiết".
  -- Unique toàn cục trên `endpoint_hash` vì một endpoint là một định danh duy nhất của
  -- Browser Push Service — cho phép nó thuộc hai `App` khác nhau nghĩa là namespace
  -- (`FR-001`) bị vi phạm âm thầm.
  CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint_hash),
  CONSTRAINT push_subscriptions_subscription_id_non_empty_check CHECK (subscription_id <> ''),
  CONSTRAINT push_subscriptions_device_id_non_empty_check CHECK (device_id <> ''),
  CONSTRAINT push_subscriptions_user_id_non_empty_check CHECK (user_id <> ''),
  CONSTRAINT push_subscriptions_app_non_empty_check CHECK (app <> ''),
  CONSTRAINT push_subscriptions_vapid_key_id_non_empty_check CHECK (vapid_key_id <> ''),
  CONSTRAINT push_subscriptions_p256dh_non_empty_check CHECK (p256dh <> ''),
  CONSTRAINT push_subscriptions_auth_non_empty_check CHECK (auth <> '')
);

-- FR-005: `status` đóng `enabled`/`disabled`; `emergency_hold` là **trục độc lập** với
-- `status` (`01-architecture.md` §5.3, `03-operations.md` §6.3/§6.5): `disable` chỉ dừng
-- routing **mới**, còn emergency hold làm delivery đã materialize không eligible tới claim.
-- Gộp hai trục thành một trường là đúng loại hỏng mà tài liệu cảnh báo.
CREATE TABLE push_providers (
  provider_id TEXT NOT NULL,
  app TEXT NOT NULL,
  transport TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disabled',
  emergency_hold INTEGER NOT NULL DEFAULT 0,
  -- Cột dormant: không có repository nào đọc `is_primary` của `push_providers` (B-9).
  -- Khai báo primary thật nằm ở `push_app_provider_mappings` (`is_primary` partial unique index).
  is_primary INTEGER NOT NULL DEFAULT 0,
  configuration_json TEXT NOT NULL DEFAULT '{}',
  disabled_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT push_providers_pkey PRIMARY KEY (provider_id),

  -- §4.2: `Transport` và `ProviderType` là hai abstraction khác nhau — `web-push` là
  -- provider **type**, không bao giờ là giá trị `transport`.
  CONSTRAINT push_providers_transport_check CHECK (transport IN ('web', 'app')),
  CONSTRAINT push_providers_type_check CHECK (type IN ('web-push', 'fcm', 'apns')),
  CONSTRAINT push_providers_status_check CHECK (status IN ('enabled', 'disabled')),

  -- Cờ boolean lưu dạng INTEGER 0/1 để predicate của claim (`emergency_hold = 0`, nằm
  -- TRONG guarded UPDATE — `01-architecture.md` §8.1) có chỗ để so sánh trực tiếp.
  CONSTRAINT push_providers_emergency_hold_check CHECK (emergency_hold IN (0, 1)),
  CONSTRAINT push_providers_is_primary_check CHECK (is_primary IN (0, 1)),

  CONSTRAINT push_providers_provider_id_non_empty_check CHECK (provider_id <> ''),
  CONSTRAINT push_providers_name_non_empty_check CHECK (name <> ''),
  CONSTRAINT push_providers_app_non_empty_check CHECK (app <> '')
);

-- FR-006 / §9 loại secret 1: provider credential (VAPID private key của `web-push`).
-- Mã hoá at rest bằng root key; `credential_encryption_version` theo dõi **version** của
-- root key để hỗ trợ multi-key rotation `K1 → K2` (§7.3).
--
-- ⚠️ Vì sao `vapid_key_id` **không** unique toàn cục: §7.2 cho phép một App có nhiều key
-- version cùng phục vụ (key mới cho subscription MỚI, key cũ cho subscription CŨ) trong
-- lúc rotation. Ràng buộc thật là **một credential version cho mỗi (provider, vapid_key_id)**
-- — được đặt ở `push_provider_credentials` (`UNIQUE (provider_id, vapid_key_id)`), để mỗi
-- key version chỉ có một row active/retired/compromised cho cùng provider. Một `vapid_key_id`
-- vẫn có thể bị dùng lại ở provider/App khác vì mỗi provider có namespace credential riêng
-- (FR-007).
CREATE TABLE push_provider_credentials (
  credential_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  app TEXT NOT NULL,
  -- Định danh key pair VAPID; runtime resolution trả credential theo `vapid_key_id` **của
  -- subscription** (§8.1, §7.2), nên đây là khoá lookup chính ở tầng claim.
  vapid_key_id TEXT NOT NULL,
  -- Client distribution dùng public key; public key **không** phải secret và được phép
  -- đọc ở tầng application — nhưng vẫn KHÔNG đi qua Queue (`01-architecture.md` §9).
  public_key TEXT NOT NULL,
  -- BLOB đã mã hoá AES-GCM (ciphertext || iv || tag). KHÔNG bao giờ plaintext.
  credential_ciphertext BLOB NOT NULL,
  credential_encryption_version TEXT NOT NULL,
  -- Vòng đời VAPID key: `active` phục vụ subscription mới, `retired` chỉ còn phục vụ
  -- subscription cũ, `compromised` phải invalidate subscription tham chiếu (§7.2).
  status TEXT NOT NULL DEFAULT 'active',
  rotated_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT push_provider_credentials_pkey PRIMARY KEY (credential_id),
  CONSTRAINT push_provider_credentials_status_check CHECK (
    status IN ('active', 'retired', 'compromised')
  ),
  CONSTRAINT push_provider_credentials_credential_id_non_empty_check CHECK (credential_id <> ''),
  CONSTRAINT push_provider_credentials_vapid_key_id_non_empty_check CHECK (vapid_key_id <> ''),
  CONSTRAINT push_provider_credentials_encryption_version_non_empty_check CHECK (
    credential_encryption_version <> ''
  ),
  CONSTRAINT push_provider_credentials_public_key_non_empty_check CHECK (public_key <> ''),

  -- Một `vapid_key_id` chỉ có **một** credential version sống cho mỗi provider: đây là
  -- chống chặn nhầm ở tầng database cho việc claim resolve nhầm row (rotation tạo key
  -- version MỚI, không sửa key cũ).
  CONSTRAINT push_provider_credentials_vapid_key_unique UNIQUE (provider_id, vapid_key_id)
);

-- FR-005/FR-007: mapping App ↔ Provider, và **đúng một** primary mỗi `(app, transport)`.
--
-- Bảng này là chỗ *duy nhất* được phép tuyên bố primary cho một scope. Vì thế "one active
-- primary per App+Transport" có **một** nguồn sự thật ở tầng database: unique **partial**
-- trên `(app, transport)` khi `is_primary = 1` — hai lần `enable` cùng scope đều bị D1 từ chối,
-- kể cả khi chạy đồng thời. Application vẫn kiểm trước để trả lý do cho admin, nhưng **guard
-- thật** nằm ở partial unique index cuối file (cùng nguyên tắc như partial unique index chống
-- dồn intent của outbox — §6.1).
--
-- ⚠️ Vì sao index này **không** nằm trong `CREATE TABLE`: SQLite/D1 không hỗ trợ partial
-- unique constraint ở cấp bảng (`UNIQUE (…) WHERE …` bên trong ngoặc ngoài của
-- `CREATE TABLE` là syntax error), chỉ hỗ trợ partial unique **index**. Vậy nên guard được
-- đặt bằng `CREATE UNIQUE INDEX` với cùng ngữ nghĩa — đây là giới hạn của engine, không phải
-- lựa chọn phong cách.
CREATE TABLE push_app_provider_mappings (
  mapping_id TEXT NOT NULL,
  app TEXT NOT NULL,
  transport TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT push_app_provider_mappings_pkey PRIMARY KEY (mapping_id),
  CONSTRAINT push_app_provider_mappings_transport_check CHECK (transport IN ('web', 'app')),
  CONSTRAINT push_app_provider_mappings_is_primary_check CHECK (is_primary IN (0, 1)),
  CONSTRAINT push_app_provider_mappings_mapping_id_non_empty_check CHECK (mapping_id <> ''),
  CONSTRAINT push_app_provider_mappings_app_non_empty_check CHECK (app <> ''),

  -- Một provider chỉ xuất hiện **một lần** cho một scope: một scope có tối đa một dòng
  -- mapping cho provider đó (ngoài dòng primary, nó là ứng viên dự phòng chưa được tuyên bố).
  CONSTRAINT push_app_provider_mappings_scope_unique UNIQUE (app, transport, provider_id)
);

-- `Push Routing Policy` theo `App` (§12 ownership; §5.5 thứ tự routing).
--
-- V1 dùng **một** hàng cho mỗi App với thứ tự ưu tiên transport cố định `app > web`
-- (`01-architecture.md` §5.5). Cột `transport_priority` lưu thứ tự đó dưới dạng chuỗi
-- phân tách bởi dấu phẩy để **mở đường** cho policy khác mà không phải đổi schema; v1 không
-- có priority/fallback/weighted routing (FR-005 nêu rõ đó là future extension).
CREATE TABLE push_routing_policy (
  app TEXT NOT NULL,
  transport_priority TEXT NOT NULL DEFAULT 'app,web',
  max_deliveries_per_notification INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT push_routing_policy_pkey PRIMARY KEY (app),
  CONSTRAINT push_routing_policy_app_non_empty_check CHECK (app <> ''),

  -- Fan-out limit FR-008: phải là số nguyên dương (0 sẽ biến mọi notification thành reject).
  CONSTRAINT push_routing_policy_max_deliveries_check CHECK (max_deliveries_per_notification >= 1)
);

-- FR-020: 12 audit event **đóng**. `detail_json` chỉ chứa mã lý do/scope, **không** secret
-- (SR-005, §17.2) — schema không bound được nội dung, đó là trách nhiệm của writer; CHECK ở đây
-- giữ được **tập event** là đóng, tức một event viết sai chính tự nó nổi lên thay vì tạo một
-- audit record không ai đọc được.
CREATE TABLE audit_records (
  audit_id TEXT NOT NULL,
  event TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  recorded_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),

  CONSTRAINT audit_records_pkey PRIMARY KEY (audit_id),

  -- Tập event FR-020 — đóng, không thêm event ngoài danh sách mà không cập nhật FR-020.
  CONSTRAINT audit_records_event_check CHECK (event IN (
    'provider_created', 'provider_updated', 'provider_enabled', 'provider_disabled',
    'provider_held', 'provider_released', 'credential_rotated',
    'subscription_disabled', 'subscription_removed', 'notification_created',
    'delivery_retried', 'delivery_republished'
  )),

  -- Actor là principal **đã xác thực** (FR-019/SR-004), không phải giá trị header tự khai.
  CONSTRAINT audit_records_actor_non_empty_check CHECK (actor <> ''),
  CONSTRAINT audit_records_entity_type_non_empty_check CHECK (entity_type <> '')
);

-- Index cho các đường truy vấn canonical. Mỗi index có comment nêu **mục đích** vì
-- `03-operations.md` §8 yêu cầu index là *structural*, không phải tuning.

-- Routing: "resolve users → devices" (`01-architecture.md` §5.5) — mỗi user của một App.
CREATE INDEX devices_app_user_idx ON devices (app, user_id, device_id);

-- Routing: chọn subscription `active` theo `(app, user_id, device_id)`; index này phục vụ
-- cả `POST /admin/v1/subscriptions` (inspect theo app) và bước resolve của §5.5.
CREATE INDEX push_subscriptions_app_user_device_idx
  ON push_subscriptions (app, user_id, device_id);

-- Đếm subscription theo `vapid_key_id` — điều kiện **bắt buộc** trước khi retire một VAPID
-- key (§7.2: "Retire key cũ CHỈ khi không còn subscription nào tham chiếu").
CREATE INDEX push_subscriptions_vapid_key_idx ON push_subscriptions (vapid_key_id, status);

-- FR-005: provider selection cần **mọi** provider ứng viên của `(app, transport)` để phát
-- hiện ambiguity — index này là phạm vi quét của nó.
CREATE INDEX push_providers_app_transport_idx ON push_providers (app, transport);

-- ⚠️ **Guard "một active primary cho mỗi App+Transport" ở tầng database** (FR-005,
-- `03-operations.md` §6.1). Partial unique index: hai admin `enable` cùng scope — kể cả
-- chạy đồng thời — thì lệnh thứ hai bị D1 từ chối bằng unique constraint, nên
-- "one active primary" **không** chỉ là một kiểm read-then-write ở application. Dòng
-- `is_primary = 0` không nằm trong index nên một ứng viên dự phòng vẫn tồn tại hợp lệ.
CREATE UNIQUE INDEX push_app_provider_mappings_one_primary
  ON push_app_provider_mappings (app, transport)
  WHERE is_primary = 1;

-- `holds` của emergency hold: operator hỏi "provider nào đang bị hold" (§15.7).
CREATE INDEX push_providers_hold_idx ON push_providers (emergency_hold, app);

-- FR-020 lookup theo một entity: đường `/admin/v1/.../:id` và điều tra incident theo id.
CREATE INDEX audit_records_entity_idx ON audit_records (entity_type, entity_id, recorded_at);

-- Đường list audit gần nhất (quét theo thời gian, không lọc entity).
CREATE INDEX audit_records_recorded_at_idx ON audit_records (recorded_at);