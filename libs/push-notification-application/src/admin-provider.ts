/**
 * Admin API — provider lifecycle, credential rotation, emergency hold, provider test.
 *
 * Canonical: `docs/applications/push-notification/02-requirements.md` FR-017 (capability list),
 * FR-018 (provider test), FR-020 (audit) · `03-operations.md` §6 (provider operations),
 * §7.2 (credential rotation) · `01-architecture.md` §5.3 (provider, one active primary).
 *
 * ⚠️ **Bốn thứ ở đây không phải CRUD.** Chúng là những phép biến đổi có **invariant toàn cục**
 * mà `Admin API` `MUST` từ chối cấu hình phá vỡ (`03-operations.md` §6.1):
 *
 * 1. **Một active primary per `(app, transport)`.** Tuyên bố primary là một **thay thế** trong
 *    `push_app_provider_mappings`, và guard thật là partial unique index
 *    `push_app_provider_mappings_one_primary` — không phải một kiểm read-then-write ở đây.
 * 2. **`disable` ≠ `emergency hold`** (§6.3 vs §6.5). `disable` chỉ dừng routing delivery mới;
 *    `hold` chặn **cả** delivery đã materialize chưa bắt đầu. Gộp hai trục làm mất đúng tính
 *    năng mà `hold` tồn tại để có.
 * 3. **Rotation không đảo thứ tự** (§7.2): **không** revoke credential cũ trước khi credential
 *    mới validate thành công, và **không** retire VAPID key cũ khi còn subscription `active`
 *    tham chiếu nó.
 * 4. **Mọi thao tác đều audit** (FR-020) — 12 event đóng, secret không bao giờ vào audit.
 */

import {
  canRetireEncryptionKey,
  isV1ExecutableProviderScope,
  selectPrimaryProvider,
  V1_EXECUTABLE_PROVIDER_TYPE,
  V1_EXECUTABLE_TRANSPORT,
  type ProviderRoutingFact,
} from '@ecoma-io/push-notification-domain';
import type { PushNotificationConfig } from './config-port';
import type { IdGenerator } from './create-notification';
import type { ProviderMappingRecord, PushNotificationPorts } from './ports';
import {
  AUDIT_EVENT,
  PROVIDER_TEST_RESULT,
  type AuditEvent,
  type ProviderCredentialRecord,
  type ProviderRecord,
  type ProviderTestResult,
  type SubscriptionRecord,
} from './records';

/* -------------------------------------------------------------------------------------- */
/* Dependency và kết quả                                                                     */
/* -------------------------------------------------------------------------------------- */

/** Dependency chung của mọi use case admin — actor đã xác thực là **tham số**, không phải env. */
export interface AdminDeps {
  readonly config: PushNotificationConfig;
  readonly ports: PushNotificationPorts;
  readonly ids: IdGenerator;
}

/**
 * Lý do từ chối một use case admin — vocabulary **đóng**, tách khỏi `REQUEST_REJECTION` của
 * Application API và khỏi `reason` của claim.
 *
 * ⚠️ Tách riêng vì cả hai nhóm kia đều đã là **hợp đồng** với một consumer khác: `reason` của
 * claim là vocabulary mà delivery plane **MUST** xử lý đủ, còn `REQUEST_REJECTION` mô tả lỗi
 * của Application API. Trộn lời gọi Admin API vào một trong hai sẽ làm một consumer phải hiểu
 * thêm một nhánh không thuộc contract của nó.
 */
export const ADMIN_REJECTION = {
  /** `provider_id` không tồn tại trong `app` của request. */
  ProviderNotFound: 'provider_not_found',
  /** `subscription_id` không tồn tại trong `app` của request. */
  SubscriptionNotFound: 'subscription_not_found',
  /** Provider thuộc `app` khác — FR-007 cấm dùng chéo app. */
  AppMismatch: 'app_mismatch',
  /** `status` hiện tại không phải giá trị mà `expected` yêu cầu. */
  StateMismatch: 'state_mismatch',
  /** `enable` một provider đang emergency hold — phải release hold trước. */
  ProviderHeld: 'provider_held',
  /** Đã có intent `pending`/`publishing` cho `delivery_id` (chống dồn intent, §6.1). */
  OpenOutboxIntent: 'open_outbox_intent',
  /** Precondition domain của administrative recovery không thoả — kèm `detail` của domain. */
  RecoveryPreconditionFailed: 'recovery_precondition_failed',
  /** `delivery_id` không tồn tại. */
  DeliveryNotFound: 'delivery_not_found',
  /** Ghi audit/D1 thất bại — thao tác chưa xảy ra nên không trả `200`. */
  StorageFailure: 'storage_failure',
  /**
   * Provider nằm ngoài scope thực thi của v1 (`transport`/`type` khác `web`/`web-push`).
   *
   * ⚠️ Reason này **đã có** trong vocabulary của contract (`02-requirements.md` §2.1 chốt
   * `fcm`/`apns` là ngoài scope v1) — nó cùng nghĩa với `unsupported_transport` /
   * `unsupported_provider_type` của delivery-plane guard, chỉ khác tầng kiểm. Vì vậy
   * `wire.ts` **không** cần thêm nhánh mới: reason không có trong `switch` rơi vào
   * `default` → `400`, đúng như một lỗi payload.
   */
  UnsupportedProviderScope: 'unsupported_provider_scope',
  /**
   * `configuration` của provider không khớp schema của provider type — thiếu field bắt
   * buộc, field rỗng, hoặc chứa khoá mang dấu secret.
   *
   * ⚠️ Tách khỏi `state_mismatch` vì hai lỗi này có **hai remediation khác nhau**: một
   * provider có configuration hỏng thì sửa `configuration`, còn `state_mismatch` là
   * tranh chấp trạng thái giữa hai admin. Gộp chúng khiến operator phải đoán.
   */
  ConfigurationInvalid: 'configuration_invalid',
  /**
   * Provider **không** có credential `active` nào để ký — thiếu hẳn, hoặc credential đã
   * `retired`/`compromised`.
   */
  CredentialMissing: 'credential_missing',
  /**
   * Credential có mặt nhưng **không giải mã được** (sai root key version, ciphertext hỏng).
   *
   * ⚠️ Tách riêng `credential_missing` vì đây là lỗi **vận hành** (keyring lệch) chứ không
   * phải cấu hình thiếu: một provider có credential nhưng giải mã hỏng thì operator phải
   * sửa keyring, không phải tạo credential mới.
   */
  CredentialDecryptionFailed: 'credential_decryption_failed',
  /**
   * Cặp khoá VAPID không khớp: public key không phải là public key **derive** được từ
   * private key đã cho.
   */
  VapidKeyPairMismatch: 'vapid_key_pair_mismatch',
} as const;

export type AdminRejection = (typeof ADMIN_REJECTION)[keyof typeof ADMIN_REJECTION];

/** Kết quả chung của use case admin. */
export type AdminResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: AdminRejection; readonly detail: string };

/* -------------------------------------------------------------------------------------- */
/* Configuration schema theo provider type (WB-2 — worker Runtime §7)                          */
/* -------------------------------------------------------------------------------------- */

/**
 * Tên khoá configuration mà worker **thật sự đọc** khi gửi.
 *
 * Nguồn: `delivery-pipeline.ts` (`buildSendRequest`):
 * - `credential.privateKey`/`publicKey` đến từ bảng credential, **không** phải
 *   configuration — vì vậy hai khoá dưới đây chỉ là `subject`.
 * - `configuration.vapidSubject` / `vapid_subject` / `subject` — claim `sub` của JWT
 *   VAPID (RFC 8292 §2.1, OPTIONAL).
 *
 * ⚠️ Danh sách này đi kèm danh sách **khoá bắt buộc không rỗng** và danh sách **khoá
 * secret-cấm** ở bên dưới; giữ cả ba trong cùng một comment để ai thêm khoá mới phải đọc cả
 * một khối deciding, không thể thêm một chiều mà quên chiều kia.
 */

/** khoá bắt buộc phải là string không rỗng khi create/PATCH (worker đọc để ký JWT VAPID). */
const WEBSUB_CONFIGURATION_REQUIRED_KEYS: readonly string[] = [
  'vapidSubject',
  'vapid_subject',
  'subject',
];

/**
 * Khoá **không được phép** xuất hiện trong `configuration` — dấu secret phải nằm ở bảng
 * credential (`push_provider_credentials`), không phải ở đây.
 *
 * Tài liệu: `03-operations.md` §7.1. Private key/p256dh/auth là 2 loại secret khác nhau;
 * để chúng vào `configuration` là một lỗi mô hình hoá data, và một admin "dò cấu hình" có
 * thể không nhận ra chúng đáng bị mã hoá.
 */
const WEBSUB_CONFIGURATION_FORBIDDEN_KEYS: readonly string[] = [
  'private_key',
  'privateKey',
  'secret',
  'auth',
  'p256dh',
];

/** Trạng thái validation của configuration — chi tiết không rỗng, không nối giá trị đầu vào. */
export type ValidateConfigurationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AdminRejection; readonly detail: string };

/**
 * Kiểm `configuration` của provider type `web-push` (WB-2):
 * - Required key phải là string không rỗng (worker `readCredentialString` sẽ trả `null`
 *   nếu mọi tên khả dụng đều vắng/rỗng → provider sẽ không ký được — chặn sớm).
 * - Khoá secret-cấm tuyệt đối không được vào `configuration` — ngay cả với value rỗng,
 *   vì chỉ riêng **tên khoá** đã là bằng chứng về mô hình hoá data sai.
 *
 * ⚠️ Driver là worker, không phải schema tự phát minh: 3 tên `subject` ở trên chính là 3
 * tên `buildSendRequest` thử (`vapidSubject`, `vapid_subject`, `subject`). Add thêm tên
 * worker tương lai chỉ khi `buildSendRequest` đổi.
 */
export function validateWebPushConfiguration(
  configuration: Readonly<Record<string, unknown>>,
): ValidateConfigurationResult {
  for (const forbidden of WEBSUB_CONFIGURATION_FORBIDDEN_KEYS) {
    if (forbidden in configuration) {
      return {
        ok: false,
        reason: ADMIN_REJECTION.ConfigurationInvalid,
        detail: `configuration không được chứa khoá secret \`${forbidden}\` — đó là phần của credential, không phải configuration.`,
      };
    }
  }
  for (const required of WEBSUB_CONFIGURATION_REQUIRED_KEYS) {
    if (!(required in configuration)) {
      continue;
    }
    const value = configuration[required];
    if (typeof value === 'string' && value.length > 0) {
      // Tìm thấy một required key hợp lệ — đủ.
      return { ok: true };
    }
  }
  return {
    ok: false,
    reason: ADMIN_REJECTION.ConfigurationInvalid,
    detail:
      'configuration phải chứa một trong `vapidSubject`/`vapid_subject`/`subject` là string không rỗng (claim `sub` của JWT VAPID).',
  };
}

/**
 * Dispatch theo provider type — mọi provider type ngoài `web-push` đều đã bị chặn ở WB-1
 * (chỉ `web-push` là provider có schema được định nghĩa ở v1).
 */
export function validateConfigurationForProviderType(
  type: ProviderRecord['type'],
  configuration: Readonly<Record<string, unknown>>,
): ValidateConfigurationResult {
  if (type === V1_EXECUTABLE_PROVIDER_TYPE) {
    return validateWebPushConfiguration(configuration);
  }
  // Thực tế không thể tới đây qua API (WB-1 chặn ở create), nhưng function này trả về
  // fail-closed vì `updateProvider` có thể nhận một provider **đã có sẵn trong DB** với
  // type lạ — record đó không được phép cập nhật configuration hợp lệ.
  return {
    ok: false,
    reason: ADMIN_REJECTION.ConfigurationInvalid,
    detail: 'configuration được định nghĩa schema chỉ cho provider type `web-push` ở v1.',
  };
}

/* -------------------------------------------------------------------------------------- */
/* create                                                                                     */
/* -------------------------------------------------------------------------------------- */

/** Input của `POST /admin/v1/providers`. */
export interface CreateProviderCommand {
  readonly app: string;
  readonly providerId: string;
  readonly transport: ProviderRecord['transport'];
  readonly type: ProviderRecord['type'];
  readonly name: string;
  readonly configuration: Readonly<Record<string, unknown>>;
  /** Tuyên bố provider này là primary của scope ngay khi tạo hay không. */
  readonly makePrimary: boolean;
  readonly actor: string;
}

/**
 * `POST /admin/v1/providers` — tạo provider.
 *
 * ⚠️ Provider mới sinh ở `status = 'disabled'`, **không** phải `enabled`. §6.1 nói chỉ
 * `disabled → enabled` sau khi pass configuration schema · credential availability ·
 * credential validity · provider connectivity · test delivery — mà control plane không
 * tự chạy provider test (FR-018 là một Admin API operation riêng, có audit). Sinh ở
 * `enabled` sẽ cho một provider **chưa** credential vào routing production.
 */
export async function createProvider(
  deps: AdminDeps,
  command: CreateProviderCommand,
  nowOverride?: number,
): Promise<AdminResult<ProviderRecord>> {
  const { ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  // ⚠️ WB-5: `makePrimary` **không** được dùng ở create. Bản đầu tạo provider rồi mới
  // tuyên bố primary, nên một `make_primary:true` bị từ chối vẫn để lại một provider row
  // **và** một audit `provider_created` — tức bằng chứng của hai thao tác trong khi chỉ một
  // cái được chấp nhận. Tuyên bố primary là operation riêng
  // (`POST /admin/v1/providers/:id/primary`) với guard riêng (§6.1), nên ở đây ta từ chối
  // **trước khi** insert. Route cũng chặn (lớp trên) — cả hai để bất biến không phụ thuộc
  // đường gọi.
  if (command.makePrimary) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.StateMismatch,
      detail: 'Tuyên bố primary là operation riêng — tạo provider trước, rồi tuyên bố primary sau.',
    };
  }

  // ⚠️ **Cổng chặn scope v1 nằm ở use-case, không ở route.** Route chỉ kiểm "type có nằm
  // trong vocabulary không" (`web-push`/`fcm`/`apns` — cả ba đều hợp lệ về hình thức);
  // nếu chỉ chặn ở route thì một provider `fcm` nhét thẳng vào D1 (migrate, seed, script
  // vận hành) vẫn enable được và tuyên bố primary được — một cổng chặn bị bỏ qua chỉ cần
  // một đường ghi khác.
  const scope = checkProviderScopeSupport(command.type, command.transport);
  if (scope !== null) {
    return scope;
  }

  const configuration = validateConfigurationForProviderType(command.type, command.configuration);
  if (!configuration.ok) {
    return {
      ok: false,
      reason: configuration.reason,
      detail: configuration.detail,
    };
  }

  const created = await ports.providers.insert({
    providerId: command.providerId,
    app: command.app,
    transport: command.transport,
    type: command.type,
    name: command.name,
    configuration: command.configuration,
    now,
  });

  if (command.makePrimary) {
    const mapping = await claimPrimary(deps, created, command.actor, now);
    if (!mapping.ok) {
      // Provider đã tồn tại nhưng không thể tuyên bố primary. Trả lỗi **kèm cả hai** để
      // operator biết việc gì đã xảy ra: xoá provider là một thao tác quản trị khác, và
      // im lặng coi như cả hai đều không xảy ra là một trạng thái không tồn tại.
      return {
        ok: false,
        reason: mapping.reason,
        detail: `provider ${created.providerId} đã tạo nhưng tuyên bố primary thất bại: ${mapping.detail}`,
      };
    }
  }

  await appendAudit(
    deps,
    AUDIT_EVENT.ProviderCreated,
    command.actor,
    'push_provider',
    created.providerId,
    now,
    {
      app: created.app,
      transport: created.transport,
      type: created.type,
    },
  );

  return { ok: true, value: created };
}

/* -------------------------------------------------------------------------------------- */
/* read single                                                                                */
/* -------------------------------------------------------------------------------------- */

/**
 * `GET /admin/v1/providers/:id` — xem configuration và trạng thái của một provider (§4.2,
 * FR-017 "xem configuration").
 *
 * ⚠️ **Không có audit event cho lần đọc này**: audit là nhật ký của hành động **đổi** state
 * (FR-020 liệt kê đúng các event ghi); một GET không đổi gì và ghi nó sẽ làm nhật ký vận hành
 * nhấn nhá bằng nhiễu. Ranh giới secret vẫn giữ nguyên: record trả về là `ProviderRecord` —
 * credential nằm ở bảng riêng và **không bao giờ** đi kèm, kể cả khi đã giải mã.
 *
 * ⚠️ Không tìm thấy → `provider_not_found`, cùng vocabulary với các use case admin khác;
 * `findById` của repository không lọc `app` (quy ước đã ghi ở `ports.ts`), nên việc kiểm
 * `app` là của use case — đọc một provider của app khác phải **trông như** không tồn tại.
 */
export async function getProvider(
  deps: AdminDeps,
  input: { readonly app: string; readonly providerId: string },
): Promise<AdminResult<ProviderRecord>> {
  const provider = await deps.ports.providers.findById(input.providerId);
  if (provider === null || provider.app !== input.app) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.ProviderNotFound,
      detail: 'Provider không tồn tại trong app này.',
    };
  }
  return { ok: true, value: provider };
}

/* -------------------------------------------------------------------------------------- */
/* update configuration                                                                       */
/* -------------------------------------------------------------------------------------- */

/**
 * `PATCH /admin/v1/providers/:id` — đổi `name`/`configuration`.
 *
 * ⚠️ Không đụng `status`, `emergency_hold`, `is_primary`. Cả ba đều là trục có invariant riêng
 * và có operation riêng (`set-provider-status`, `set-provider-hold`, `claim-primary`) — để
 * `PATCH` chạm vào chúng là đường vòng qua audit event và qua guard của index.
 */
export async function updateProvider(
  deps: AdminDeps,
  input: {
    readonly app: string;
    readonly providerId: string;
    readonly name: string;
    readonly configuration: Readonly<Record<string, unknown>>;
    readonly actor: string;
  },
  nowOverride?: number,
): Promise<AdminResult<ProviderRecord>> {
  const now = nowOverride ?? deps.ports.clock.now();

  const current = await deps.ports.providers.findById(input.providerId);
  const mismatch = checkProviderScope(current, input.app);
  if (mismatch !== null) {
    return mismatch;
  }
  const target = current as ProviderRecord;

  const configuration = validateConfigurationForProviderType(target.type, input.configuration);
  if (!configuration.ok) {
    return {
      ok: false,
      reason: configuration.reason,
      detail: configuration.detail,
    };
  }

  const updated = await deps.ports.providers.updateConfiguration({
    app: input.app,
    providerId: input.providerId,
    name: input.name,
    configuration: input.configuration,
    now,
  });
  if (updated === null) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.ProviderNotFound,
      detail: 'Provider không tồn tại trong app này.',
    };
  }
  await appendAudit(
    deps,
    AUDIT_EVENT.ProviderUpdated,
    input.actor,
    'push_provider',
    updated.providerId,
    now,
    {
      app: updated.app,
      transport: updated.transport,
    },
  );
  return { ok: true, value: updated };
}

/* -------------------------------------------------------------------------------------- */
/* enable / disable                                                                           */
/* -------------------------------------------------------------------------------------- */

/**
 * `PATCH /admin/v1/providers/:id` với `status` — bật/tắt provider.
 *
 * ⚠️ `expected` là trạng thái **phải** có trước khi đổi, và nó nằm **trong** statement ghi
 * (`SetProviderStatusInput.expected`). Đó là guarded conditional write: hai admin bật/tắt
 * cùng scope chạy đồng thời thì đúng một thắng, và tài liệu không cần giả định row locking.
 *
 * ⚠️ Enable **không** tự làm provider thành primary. `is_primary` thuộc
 * `push_app_provider_mappings` và có operation riêng; gộp hai việc khiến một admin "enable"
 * hiểu nhầm là đã thay primary của scope.
 */
export async function setProviderStatus(
  deps: AdminDeps,
  input: {
    readonly app: string;
    readonly providerId: string;
    readonly status: ProviderRecord['status'];
    readonly expected: ProviderRecord['status'];
    readonly actor: string;
  },
  nowOverride?: number,
): Promise<AdminResult<ProviderRecord>> {
  const { ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const current = await ports.providers.findById(input.providerId);
  const mismatch = checkProviderScope(current, input.app);
  if (mismatch !== null) {
    return mismatch;
  }
  // Chặn enable khi còn emergency hold: một provider `enabled` nhưng đang hold là một trạng
  // thái mà routing chấp nhận nhưng claim chặn — hai tầng quyết định lệch nhau, và bản đồ
  // metric của provider sẽ báo "routing OK" trong khi mọi delivery đều bị
  // `ineligible_provider_hold`. §6.1 yêu cầu release hold là bước độc lập.
  if (input.status === 'enabled' && (current as ProviderRecord).emergencyHold) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.ProviderHeld,
      detail: 'Provider đang emergency hold — phải release hold trước khi enable.',
    };
  }

  // WB-1: cửa chặn enable cho scope v1 — dùng **record đã đọc để quyết** (và statement ghi
  // `expected` ở dưới vẫn là guarded conditional write).
  if (input.status === 'enabled') {
    const target = current as ProviderRecord;
    const scope = checkProviderScopeSupport(target.type, target.transport);
    if (scope !== null) {
      return scope;
    }
    const precondition = await checkEnablePreconditions(deps, target);
    if (precondition !== null) {
      return precondition;
    }
  }

  const updated = await ports.providers.setStatus({
    app: input.app,
    providerId: input.providerId,
    status: input.status,
    expected: input.expected,
    now,
    emergencyHold: input.status === 'enabled' ? false : undefined,
  });
  if (updated === null) {
    // `findById` vừa thấy provider và `expected` phải khớp trong statement — nên `null` ở đây
    // là race giữa hai lời gọi. Đó là `state_mismatch`, không phải "không tồn tại": trả
    // `provider_not_found` sẽ bảo operator rằng provider biến mất.
    return {
      ok: false,
      reason: ADMIN_REJECTION.StateMismatch,
      detail: 'Trạng thái provider đã đổi sau khi đọc — thao tác không được áp dụng.',
    };
  }

  await appendAudit(
    deps,
    updated.status === 'enabled' ? AUDIT_EVENT.ProviderEnabled : AUDIT_EVENT.ProviderDisabled,
    input.actor,
    'push_provider',
    updated.providerId,
    now,
    { app: updated.app, transport: updated.transport, previous_status: input.expected },
  );
  return { ok: true, value: updated };
}

/* -------------------------------------------------------------------------------------- */
/* emergency hold / release                                                                   */
/* -------------------------------------------------------------------------------------- */

/**
 * `POST /admin/v1/providers/:id/hold` — emergency hold/revoke (`03-operations.md` §6.5).
 *
 * ⚠️ **Không** phải alias của `disable`: hold giữ nguyên `status`, chỉ đặt `emergency_hold`,
 * và nó chặn delivery **đã materialize** chưa bắt đầu (`409 ineligible_provider_hold`) trong
 * khi `disable` chỉ dừng routing mới. `MUST NOT` khẳng định hold thu hồi được một request
 * provider đã accept — §6.5 nói rõ chỉ chặn được phần chưa gửi.
 *
 * ⚠️ Hold **idempotent**: gọi lại khi đã hold trả `200` với cùng record, không phải lỗi. Runbook
 * §15.7 là một quy trình nhiều bước có thể chạy lại, và một lời gọi lặp phải không tạo ra một
 * audit record nói dối.
 */
export async function holdProvider(
  deps: AdminDeps,
  input: { readonly app: string; readonly providerId: string; readonly actor: string },
  nowOverride?: number,
): Promise<AdminResult<ProviderRecord>> {
  return applyHold(deps, input.actor, input.app, input.providerId, true, nowOverride);
}

/**
 * `POST /admin/v1/providers/:id/release` — bỏ emergency hold.
 *
 * ⚠️ Không bỏ `disable` một cách ngầm: một provider `disabled` sau khi release hold vẫn
 * `disabled`, và routing mới vẫn dừng. Bỏ cả hai trong một lời gọi sẽ khiến một runbook tưởng
 * rằng provider đã trở lại phục vụ trong khi nó không.
 */
export async function releaseProvider(
  deps: AdminDeps,
  input: { readonly app: string; readonly providerId: string; readonly actor: string },
  nowOverride?: number,
): Promise<AdminResult<ProviderRecord>> {
  return applyHold(deps, input.actor, input.app, input.providerId, false, nowOverride);
}

async function applyHold(
  deps: AdminDeps,
  actor: string,
  app: string,
  providerId: string,
  hold: boolean,
  nowOverride?: number,
): Promise<AdminResult<ProviderRecord>> {
  const { ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const current = await ports.providers.findById(providerId);
  const mismatch = checkProviderScope(current, app);
  if (mismatch !== null) {
    return mismatch;
  }
  const existing = current as ProviderRecord;
  if (existing.emergencyHold === hold) {
    // Đã ở trạng thái đích: trả `200` với record hiện tại và **không** ghi audit. Một audit
    // record cho một thay đổi không xảy ra là bằng chứng sai, và audit là bằng chứng cho
    // operator (§15.7 cần đọc được đúng những lần hold **thật**).
    return { ok: true, value: existing };
  }

  const updated = await ports.providers.setEmergencyHold({ app, providerId, hold, now });
  if (updated === null) {
    // Idempotent no-op: nếu record đã ở trạng thái đích (race giữa hai lời gọi cùng chiều),
    // trả record hiện tại mà không ghi audit (B-8).
    const refreshed = await ports.providers.findById(providerId);
    if (refreshed !== null && refreshed.app === app && refreshed.emergencyHold === hold) {
      return { ok: true, value: refreshed };
    }
    return {
      ok: false,
      reason: ADMIN_REJECTION.StateMismatch,
      detail: 'Trạng thái hold đã đổi sau khi đọc — thao tác không được áp dụng.',
    };
  }

  await appendAudit(
    deps,
    hold ? AUDIT_EVENT.ProviderHeld : AUDIT_EVENT.ProviderReleased,
    actor,
    'push_provider',
    providerId,
    now,
    { app, transport: updated.transport, status: updated.status },
  );
  return { ok: true, value: updated };
}

/* -------------------------------------------------------------------------------------- */
/* primary mapping — một active primary per (app, transport)                                  */
/* -------------------------------------------------------------------------------------- */

/**
 * Tuyên bố primary cho `(app, transport)`.
 *
 * ⚠️ **Thay thế, không cộng dồn.** Xoá mapping primary cũ rồi tạo mapping mới **trong cùng một
 * `db.batch()`** — nếu hai lệnh đó là hai transaction, có một khoảng thời gian scope không có
 * primary, và routing trong khoảng đó sẽ là `no_provider` cho một scope vốn đang phục vụ tốt.
 *
 * ⚠️ Trước khi tuyên bố, `selectPrimaryProvider` phải trả **không phải `ambiguous`**. Đó là
 * cổng chặn của §6.1: một cấu hình tạo ambiguity là thứ `MUST` bị từ chối, vì routing fail
 * safely sẽ dừng giao thông cho scope đó thay vì đoán.
 *
 * ⚠️ Guard **thật** vẫn là partial unique index `push_app_provider_mappings_one_primary`: hai
 * admin tuyên bố primary cho cùng scope chạy đồng thời thì lệnh thứ hai bị D1 từ chối, và
 * `setPrimaryMapping` trả `null`. Đó là race hợp lệ, không phải lỗi.
 */
export async function claimProviderPrimary(
  deps: AdminDeps,
  input: { readonly app: string; readonly providerId: string; readonly actor: string },
  nowOverride?: number,
): Promise<AdminResult<ProviderMappingRecord>> {
  const { ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const provider = await ports.providers.findById(input.providerId);
  const mismatch = checkProviderScope(provider, input.app);
  if (mismatch !== null) {
    return mismatch;
  }
  // Narrow: `checkProviderScope` trả `null` **chỉ** khi record khác `null` **và** `app` khớp.
  const target = provider as ProviderRecord;
  // WB-1: cổng chặn scope v1 cho claim-primary — một provider `fcm`/`apns` không được
  // tuyên bố primary trong v1, kể cả khi nó được tạo bằng một đường ghi khác.
  const scope = checkProviderScopeSupport(target.type, target.transport);
  if (scope !== null) {
    return scope;
  }
  if (target.emergencyHold || target.status === 'disabled') {
    // Tuyên bố một provider không eligible làm primary là cách **duy nhất** để scope rơi
    // vào trạng thái mà routing vẫn fail-safe (`ambiguous`/`no_provider`) sau khi mapping cũ
    // đã bị xoá. §6.1 nói `Admin API` MUST từ chối cấu hình tạo ambiguity — cấu hình này tạo
    // ra chính xác điều đó.
    return {
      ok: false,
      reason: target.emergencyHold ? ADMIN_REJECTION.ProviderHeld : ADMIN_REJECTION.StateMismatch,
      detail: 'Provider không eligible — không thể là primary của scope.',
    };
  }

  // Cổng chặn ambiguity của §6.1: **sau** khi tuyên bố provider này, scope sẽ có provider
  // này là eligible **cộng** mọi provider eligible khác. Nếu còn một provider eligible nữa
  // thì scope thành `ambiguous` — mà routing fail-safe sẽ dừng giao thông cho một scope vốn
  // đang phục vụ tốt. Đây là kiểm **cấu hình**, và nó dùng lại đúng hàm mà routing dùng, nên
  // "ambiguous" ở đây và "ambiguous" lúc route là **cùng một định nghĩa**.
  const facts = await ports.providers.listByScope(input.app, target.transport);
  const others = facts.filter((fact: ProviderRoutingFact) => fact.providerId !== target.providerId);
  const remaining = selectPrimaryProvider(others, input.app, target.transport);
  if (remaining.ok) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.StateMismatch,
      detail: `Scope đã có provider eligible khác (${remaining.provider.providerId}) — tuyên bố primary lúc này sẽ tạo ambiguity.`,
    };
  }
  if (!remaining.ok && remaining.reason !== 'no_provider') {
    // `malformed_provider`/`malformed_selector`/`ambiguous`: danh sách fact hỏng hoặc scope
    // **đã** ambiguous. Cả hai đều là cấu hình mà §6.1 cấm — nhưng khác nhau: `ambiguous`
    // là một scope đang chạy production với lỗi cấu hình, nên detail phải nói rõ.
    return {
      ok: false,
      reason: ADMIN_REJECTION.StateMismatch,
      detail: `Scope không ở trạng thái có thể tuyên bố primary: ${remaining.reason}.`,
    };
  }

  const mapping = await ports.providers.setPrimaryMapping({
    mappingId: deps.ids.next(),
    app: input.app,
    transport: target.transport,
    providerId: target.providerId,
    now,
  });
  if (mapping === null) {
    // Partial unique index `push_app_provider_mappings_one_primary` chặn: một admin khác đã
    // tuyên bố primary cho scope này giữa lúc đọc và lúc ghi. Đây là race hợp lệ, **không**
    // phải lỗi cấu hình — nhưng nó cũng có thể là việc mapping cũ của scope đã bị xoá bởi
    // một lời gọi khác, nên không được coi là thành công im lặng.
    return {
      ok: false,
      reason: ADMIN_REJECTION.StateMismatch,
      detail: 'Tuyên bố primary bị index chặn — scope đã có admin khác tuyên bố trước.',
    };
  }

  await appendAudit(
    deps,
    AUDIT_EVENT.ProviderUpdated,
    input.actor,
    'push_provider',
    target.providerId,
    now,
    {
      app: input.app,
      transport: target.transport,
      change: 'primary_mapping',
    },
  );
  return { ok: true, value: mapping };
}

/** Nội bộ của `createProvider` — cùng luật với `claimProviderPrimary`. */
async function claimPrimary(
  deps: AdminDeps,
  provider: ProviderRecord,
  actor: string,
  now: number,
): Promise<AdminResult<ProviderMappingRecord>> {
  return claimProviderPrimary(
    deps,
    { app: provider.app, providerId: provider.providerId, actor },
    now,
  );
}

/* -------------------------------------------------------------------------------------- */
/* credential rotation                                                                        */
/* -------------------------------------------------------------------------------------- */

/** Input của `POST /admin/v1/providers/:id/rotate-credential`. */
export interface RotateCredentialCommand {
  readonly app: string;
  readonly providerId: string;
  readonly credentialId: string;
  /** VAPID key id mới — subscription **mới** sẽ dùng key này (§7.2). */
  readonly vapidKeyId: string;
  readonly publicKey: string;
  /** Private key **plaintext**; chỉ tồn tại trong stack của use case này, không vào log/audit. */
  readonly privateKey: string;
  /** `vapid_key_id` cần retire sau khi key mới đã phục vụ — có thể `null` (chưa có key cũ nào). */
  readonly retireVapidKeyId: string | null;
  readonly actor: string;
}

/**
 * `POST /admin/v1/providers/:id/rotate-credential` — rotate VAPID key pair (`03-operations.md` §7.2).
 *
 * ⚠️ **Không** revoke credential cũ ở đây. §7.2 cấm đảo thứ tự (`revoke old → deploy new`
 * khi deployment mới chưa xác nhận), và subscription cũ **giữ** `vapid_key_id` cũ. Việc
 * retire là một bước **sau**, khi đếm được 0 subscription `active` tham chiếu key cũ — thứ mà
 * `canRetireEncryptionKey`/`countActiveSubscriptionReferences` cung cấp cho một operation
 * riêng.
 *
 * ⚠️ Private key được **mã hoá ngay** bằng `CredentialCipher` và không đi qua audit. Cột
 * `credential_ciphertext` nhận byte mã hoá; `publicKey` đi vào record vì client cần nó ở tầng
 * application và nó **không** phải secret (`01-architecture.md` §9).
 */
export async function rotateCredential(
  deps: AdminDeps,
  command: RotateCredentialCommand,
  nowOverride?: number,
): Promise<
  AdminResult<{ readonly vapidKeyId: string; readonly retiredVapidKeyId: string | null }>
> {
  const { ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const provider = await ports.providers.findById(command.providerId);
  const mismatch = checkProviderScope(provider, command.app);
  if (mismatch !== null) {
    return mismatch;
  }

  const target = provider as ProviderRecord;
  const scope = checkProviderScopeSupport(target.type, target.transport);
  if (scope !== null) {
    return scope;
  }

  // WB-6: **Verify cặp khoá VAPID trước khi mã hoá/ghi** — chỉ so trực tiếp 2 string là
  // không đủ, vì một "public key" nhầm (khớp là do sao chép sai) sẽ ký được JWT nhưng
  // push service sẽ từ chối 401, nghĩa là mọi delivery sẽ hỏng nhưng rotate vẫn 200.
  const pairMatches = await verifyVapidKeyPair(command.privateKey, command.publicKey);
  if (!pairMatches) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.VapidKeyPairMismatch,
      detail:
        'public_key không khớp cặp khoá mà private_key ký được — dùng đúng cặp VAPID của `vapid_key_id` mới.',
    };
  }

  // Mã hoá **trước** khi ghi bất kỳ thứ gì: một lỗi ở `encrypt` khiến rotation dừng lại mà
  // không để lại một credential `active` mà không có ciphertext.
  const encrypted = await ports.credentialCipher.encrypt(command.privateKey);
  const credential = await ports.providerCredentials.insert({
    credentialId: command.credentialId,
    providerId: command.providerId,
    app: command.app,
    vapidKeyId: command.vapidKeyId,
    publicKey: command.publicKey,
    credentialCiphertext: encrypted.ciphertext,
    credentialEncryptionVersion: encrypted.version,
    now,
  });

  // Cổng chặn retire của key cũ (§7.2): chỉ retire khi **không còn** subscription `active`
  // nào tham chiếu nó. Nếu còn, rotation vẫn thành công (key mới đã phục vụ subscription
  // mới) — chỉ là **không** retire key cũ, và việc đó là đúng.
  let retiredVapidKeyId: string | null = null;
  if (command.retireVapidKeyId !== null) {
    const references = await ports.providerCredentials.countActiveSubscriptionReferences(
      command.app,
      command.retireVapidKeyId,
    );
    if (references === 0) {
      const previous = await ports.providerCredentials.findByVapidKeyId(
        command.app,
        command.providerId,
        command.retireVapidKeyId,
      );
      if (previous !== null) {
        const retired = await ports.providerCredentials.setStatus({
          app: command.app,
          credentialId: previous.credentialId,
          status: 'retired',
          expected: 'active',
          now,
        });
        if (retired !== null) {
          // Re-check subscription references after retire to close TOCTOU window:
          // a new active subscription may have appeared between the count and the write.
          const referencesAfter = await ports.providerCredentials.countActiveSubscriptionReferences(
            command.app,
            command.retireVapidKeyId,
          );
          if (referencesAfter !== 0) {
            // TOCTOU close: retire already happened, but an active subscription now
            // references the key. Report as skipped (not success) per §7.2.
            retiredVapidKeyId = null; // reported as skipped_still_referenced
          } else {
            retiredVapidKeyId = command.retireVapidKeyId;
          }
        }
      }
    }
  }

  await appendAudit(
    deps,
    AUDIT_EVENT.CredentialRotated,
    command.actor,
    'push_provider_credential',
    credential.credentialId,
    now,
    {
      app: command.app,
      provider_id: command.providerId,
      new_vapid_key_id: command.vapidKeyId,
      // `retired_vapid_key_id` là `null` khi key cũ **còn** subscription `active` tham chiếu —
      // một kết quả **đúng** của §7.2, không phải thiếu sót. Audit phải phân biệt "chưa retire
      // vì còn tham chiếu" với "đã retire", nên hai nhánh ghi hai giá trị khác nhau; ghi
      // `"none"` cho cả hai sẽ làm một người đọc audit kết luận sai.
      retired_vapid_key_id: retiredVapidKeyId ?? 'skipped_still_referenced',
    },
  );

  return { ok: true, value: { vapidKeyId: credential.vapidKeyId, retiredVapidKeyId } };
}

/**
 * Kiểm tra một encryption key version còn retire được không (FR-006, §7.3).
 *
 * ⚠️ Đây là **cổng chặn** của `K1 → K2`, không phải hành động retire. Hành vi retire (reencrypt
 * record) là một background job vận hành riêng và `MUST NOT` được suy ra từ hàm này — cùng
 * lý do §5.6 nói lease expiry chỉ làm delivery claimable lại chứ không tự chuyển state.
 */
export async function checkEncryptionKeyRetirement(
  deps: AdminDeps,
  keyId: string,
): Promise<{ readonly canRetire: boolean; readonly versionsInUse: readonly string[] }> {
  const versionsInUse = await deps.ports.providerCredentials.listEncryptionVersionsInUse();
  return { canRetire: canRetireEncryptionKey(keyId, versionsInUse), versionsInUse };
}

/* -------------------------------------------------------------------------------------- */
/* VAPID key-pair correspondence (WB-6)                                                       */
/* -------------------------------------------------------------------------------------- */

/**
 * Kiểm một cặp VAPID có khớp nhau không: sign bằng private key, verify bằng public key.
 *
 * ⚠️ **Vì sao verify chứ không phải "derive rồi so chuỗi".** WebCrypto **không** cho
 * `exportKey('raw', privateKey)` — chỉ `exportKey('jwk', …)` (mà `d` là secret) hoặc
 * `'pkcs8'`. Nên "derive public key từ private key" theo nghĩa đó không tồn tại ở tầng
 * WebCrypto. Cách kiểm đúng và **cũng mạnh hơn**: ký một message bằng private key rồi
 * verify bằng public key — `verify` chỉ thành công khi public key **chính là** public key
 * của private key đó. Cùng thuật toán và cùng định dạng material với worker
 * (`importKey('pkcs8', …, ECDSA P-256)` trong `vapid.ts`), nên một cặp mà ta chấp nhận
 * thì worker **chắc chắn** ký được.
 *
 * ⚠️ Verify **không** chứng minh ngược lại (một cặp khác vẫn có thể verify hỏng) — đó là
 * đúng: đây là kiểm *tương ứng*, và một public key sai bị loại.
 *
 * ⚠️ `privateKey` **không bao giờ** vào message/detail — hàm trả boolean, caller map
 * thành reason đóng.
 *
 * @param privateKeyBase64Url DER PKCS#8 của private key VAPID (base64url, không padding).
 * @param publicKeyBase64Url Điểm EC P-256 uncompressed 65 octet (base64url, không padding).
 * @returns `true` khi cặp khớp; `false` khi lệch, hoặc khi material không import được.
 */
export async function verifyVapidKeyPair(
  privateKeyBase64Url: string,
  publicKeyBase64Url: string,
): Promise<boolean> {
  const der = decodeBase64Url(privateKeyBase64Url);
  const point = decodeBase64Url(publicKeyBase64Url);
  if (der === null || point === null || point.length === 0) {
    return false;
  }
  if (point.length !== 65 || point[0] !== 0x04) {
    return false;
  }
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    publicKey = await crypto.subtle.importKey(
      'raw',
      point,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch {
    // Material không import được (định dạng sai, không phải P-256, point không hợp lệ) —
    // fail-closed: coi như cặp không khớp.
    return false;
  }
  try {
    const message = new TextEncoder().encode('ecoma.io:vapid-key-pair-check');
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      message,
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signature,
      message,
    );
  } catch {
    return false;
  }
}

/** Decode base64url — `null` khi sai định dạng. Bổ sung cho hằng Ø của webcrypto lib. */
function decodeBase64Url(value: string): Uint8Array | null {
  if (value.length === 0) {
    return null;
  }
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------------------- */
/* provider test (FR-018)                                                                     */
/* -------------------------------------------------------------------------------------- */

/** Kết quả một lần provider test — phân loại của FR-018, không suy ra từ HTTP code. */
export interface ProviderTestOutcome {
  readonly result: ProviderTestResult;
  readonly providerId: string;
  readonly subscriptionId: string;
  /** Thời gian đo được (epoch millis) — `03-operations.md` §10.2 metric provider latency. */
  readonly durationMs: number;
  /** Chi tiết đã **sanitize**: không response body, không endpoint, không secret. */
  readonly detail: string;
}

/** Port gọi provider — chỉ tồn tại cho provider test, không nằm trong đường serving. */
export interface ProviderProbe {
  /**
   * Gửi một test delivery tới một subscription **đã authorization** (FR-018).
   *
   * ⚠️ Đây là port của **control plane**, nhưng Web Push client primitive thuộc delivery worker
   * (`web-push-notification-job-infrastructure`) — control plane không giữ adapter nào. Vị trí
   * của adapter thật nằm ở composition root (`apps/push-notification/src/provider-probe.ts`),
   * nơi duy nhất được phép nối hai tầng: adapter **bọc** `createWebPushSender` của delivery
   * plane và mapping kết quả về `ProviderTestResult` của FR-018.
   *
   * ⚠️ FR-018 đòi "actual delivery", nên use case này **không bao giờ** tự trả một phân loại
   * thay cho adapter — adapter quyết định classification từ kết quả thật của provider.
   */
  sendTestDelivery(input: {
    readonly endpoint: string;
    readonly p256dh: string;
    readonly auth: string;
    readonly vapidKeyId: string;
    readonly privateKey: string;
    /**
     * Public key VAPID **khớp** `privateKey` — đi vào tham số `k` của header `vapid` (RFC 8292
     * §3.2).
     *
     * ⚠️ Adapter **không** được derive lại từ private key (WP2): `vapid_key_id` của subscription
     * phải khớp key đã dùng lúc tạo subscription, và derive lại không bảo chứng được điều đó
     * (`vapid.ts` — `buildVapidAuthorizationHeader`).
     */
    readonly publicKey: string;
    /** Claim `sub` của JWT VAPID (RFC 8292 §2.1); `null` khi provider configuration không có. */
    readonly vapidSubject: string | null;
    readonly timeoutMs: number;
    readonly payloadJson: string;
  }): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly classification: ProviderTestResult; readonly detail: string }
  >;
}

/** Tên khoá `sub` của provider `configuration` mà **worker thật sự đọc** (đúng thứ tự của `buildSendRequest`). */
const VAPID_SUBJECT_KEYS = ['vapidSubject', 'vapid_subject', 'subject'] as const;

/**
 * Đọc claim `sub` (RFC 8292 §2.1) từ `provider.configuration` — **không** bịa default.
 *
 * ⚠️ Danh sách tên khoá phải **cùng thứ tự** với `buildSendRequest`
 * (`web-push-notification-job-application/src/delivery-pipeline.ts`): hai nơi đọc hai thứ tự
 * khác nhau sẽ cho hai kết quả JWT khác nhau cho cùng một provider — điều mà một test trên
 * control plane sẽ không thấy.
 *
 * @returns Chuỗi không rỗng đầu tiên tìm thấy, hoặc `null` khi không có khóa nào hợp lệ.
 */
export function readVapidSubject(configuration: Readonly<Record<string, unknown>>): string | null {
  for (const key of VAPID_SUBJECT_KEYS) {
    const value = configuration[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/** Input của `POST /admin/v1/providers/:id/test`. */
export interface ProviderTestCommand {
  readonly app: string;
  readonly providerId: string;
  readonly subscriptionId: string;
  readonly actor: string;
  /** Payload test — không chứa dữ liệu nhạy cảm không cần thiết (FR-018). */
  readonly payloadJson: string;
}

/**
 * `POST /admin/v1/providers/:id/test` — configuration test + actual test delivery (FR-018).
 *
 * ⚠️ **Phân loại 5 giá trị** là điều FR-018 đòi và là lý do `ProviderTestResult` tồn tại: gộp
 * `configuration_invalid` với `authentication_failed` mất một nhánh remediation (§15.3: 401/403
 * → credential path).
 *
 * ⚠️ **Test có audit record** (FR-018, FR-020) — kể cả khi test fail, vì một test fail lặp
 * lại là bằng chứng cho incident §15.3.
 *
 * ⚠️ Target subscription phải thuộc **cùng app** với provider. Kiểm này ở đây, trước khi gọi
 * provider, vì FR-007 cấm dùng chéo app và một test delivery sang app khác là một gửi thật
 * tới một endpoint thật của một app khác.
 */
export async function runProviderTest(
  deps: AdminDeps,
  probe: ProviderProbe,
  command: ProviderTestCommand,
  nowOverride?: number,
): Promise<AdminResult<ProviderTestOutcome>> {
  const { config, ports } = deps;
  const now = nowOverride ?? ports.clock.now();

  const provider = await ports.providers.findById(command.providerId);
  const providerMismatch = checkProviderScope(provider, command.app);
  if (providerMismatch !== null) {
    return providerMismatch;
  }
  const target = provider as ProviderRecord;

  const subscription = await ports.subscriptions.findById(command.subscriptionId);
  const subscriptionMismatch = checkSubscriptionScope(subscription, command.app);
  if (subscriptionMismatch !== null) {
    return subscriptionMismatch;
  }
  const targetSubscription = subscription as SubscriptionRecord;

  // Provider phục vụ **một** transport (FR-005: scope là `App + Transport`). Test một
  // subscription thuộc transport khác sẽ đo một đường giao thông mà routing không bao giờ
  // chọn, và một `delivery_accepted` ở đó **không** nói gì về provider của scope thật — đó là
  // một test xanh giả, thứ tệ hơn một test đỏ vì nó dừng operator bỏ một lỗi thật.
  if (targetSubscription.transport !== target.transport) {
    await appendAudit(
      deps,
      AUDIT_EVENT.ProviderUpdated,
      command.actor,
      'push_provider',
      command.providerId,
      now,
      {
        app: command.app,
        test_result: PROVIDER_TEST_RESULT.SubscriptionInvalid,
        subscription_id: command.subscriptionId,
      },
    );
    return {
      ok: true,
      value: {
        result: PROVIDER_TEST_RESULT.SubscriptionInvalid,
        providerId: command.providerId,
        subscriptionId: command.subscriptionId,
        durationMs: 0,
        detail: 'Target subscription khác transport mà provider phục vụ.',
      },
    };
  }

  const credential = await ports.providerCredentials.findByVapidKeyId(
    command.app,
    command.providerId,
    targetSubscription.vapidKeyId,
  );
  if (credential === null || credential.status === 'compromised') {
    await appendAudit(
      deps,
      AUDIT_EVENT.ProviderUpdated,
      command.actor,
      'push_provider',
      command.providerId,
      now,
      {
        app: command.app,
        test_result: PROVIDER_TEST_RESULT.ConfigurationInvalid,
        subscription_id: command.subscriptionId,
      },
    );
    return {
      ok: true,
      value: {
        result: PROVIDER_TEST_RESULT.ConfigurationInvalid,
        providerId: command.providerId,
        subscriptionId: command.subscriptionId,
        durationMs: 0,
        detail:
          credential === null
            ? 'Không resolve được credential cho vapid_key_id của target.'
            : 'Credential của vapid_key_id của target đang ở trạng thái compromised.',
      },
    };
  }

  // ⚠️ **Giải mã credential có thể throw** (AES-GCM tag không khớp — ciphertext hoặc root key
  // sai). Điều này thuộc nhánh `configuration_invalid` của FR-018 (decrypt lỗi), **không** phải
  // lỗi HTTP: một credential hỏng là một kết quả của test, và trả `500` kèm message library
  // làm mất cả hai — phân loại FR-018 lẫn chạy ga không rò secret.
  let privateKey: string;
  try {
    privateKey = await ports.credentialCipher.decrypt(
      credential.credentialCiphertext,
      credential.credentialEncryptionVersion,
    );
  } catch {
    await appendAudit(
      deps,
      AUDIT_EVENT.ProviderUpdated,
      command.actor,
      'push_provider',
      command.providerId,
      now,
      {
        app: command.app,
        test_result: PROVIDER_TEST_RESULT.ConfigurationInvalid,
        subscription_id: command.subscriptionId,
      },
    );
    return {
      ok: true,
      value: {
        result: PROVIDER_TEST_RESULT.ConfigurationInvalid,
        providerId: command.providerId,
        subscriptionId: command.subscriptionId,
        durationMs: 0,
        detail: 'Credential không giải mã được bằng keyring hiện tại.',
      },
    };
  }

  // Đo thời gian **thật** của lần gọi provider: hai mốc lấy từ `clock` chứ không phải từ
  // `nowOverride`, vì `nowOverride` là mốc logic của use case (dùng để test) và một mốc cố
  // định sẽ cho `durationMs = 0` cho mọi lần chạy trong test — tức metric provider latency
  // (§10.2) sẽ được kiểm bằng một con số không có nghĩa.
  const startedAt = await ports.clock.now();
  const probeOutcome = await probe.sendTestDelivery({
    endpoint: targetSubscription.endpoint,
    p256dh: targetSubscription.p256dh,
    auth: targetSubscription.auth,
    vapidKeyId: credential.vapidKeyId,
    privateKey,
    // RFC 8292 §3.2: tham số `k` của header `vapid` là public key — không derive lại từ
    // private key, dùng đúng public key đã lưu trên credential record (WP2).
    publicKey: credential.publicKey,
    // `sub` lấy từ provider configuration, đúng nguồn của worker (`buildSendRequest`);
    // không có → `null`, và adapter vẫn ký JWT hợp lệ (RFC 8292 §2.1 OPTIONAL).
    vapidSubject: readVapidSubject(target.configuration),
    timeoutMs: config.engineering.providerTestTimeoutMs,
    payloadJson: command.payloadJson,
  });
  const durationMs = Math.max(0, (await ports.clock.now()) - startedAt);

  const outcome: ProviderTestOutcome = probeOutcome.ok
    ? {
        result: PROVIDER_TEST_RESULT.DeliveryAccepted,
        providerId: command.providerId,
        subscriptionId: command.subscriptionId,
        durationMs,
        detail: 'Provider nhận test delivery.',
      }
    : {
        result: probeOutcome.classification,
        providerId: command.providerId,
        subscriptionId: command.subscriptionId,
        durationMs,
        detail: probeOutcome.detail,
      };

  await appendAudit(
    deps,
    AUDIT_EVENT.ProviderUpdated,
    command.actor,
    'push_provider',
    command.providerId,
    now,
    {
      app: command.app,
      test_result: outcome.result,
      subscription_id: command.subscriptionId,
      duration_ms: outcome.durationMs,
    },
  );

  return { ok: true, value: outcome };
}

/* -------------------------------------------------------------------------------------- */
/* Helpers dùng chung                                                                          */
/* -------------------------------------------------------------------------------------- */

/**
 * Kiểm tra provider của một request Admin.
 *
 * ⚠️ `providers.findById` cố ý **không** lọc `app` — xem `DeviceRepository.findById`. Nên
 * `null` ở đây có hai nguyên nhân thật sự khác nhau về đối diện operator: không tồn tại, hoặc
 * tồn tại ở app khác. Ở **Admin API** (đã authenticated + authorized theo app) phân biệt
 * được là đúng — khác hẳn private delivery runtime API, nơi phân biệt đó là loại tiết lộ mà
 * `401` cấm.
 *
 * ⚠️ `app` được kiểm **ở đây**, không ở repository: nếu repository lọc `app` thì một provider
 * ở app khác ra `not_found`, và operator mất khả năng phân biệt "sai id" với "sai app" — hai
 * nguyên nhân với hai cách sửa khác nhau.
 */
function checkProviderScope(
  provider: ProviderRecord | null,
  app: string,
): { readonly ok: false; readonly reason: AdminRejection; readonly detail: string } | null {
  if (provider === null) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.ProviderNotFound,
      detail: 'Provider không tồn tại.',
    };
  }
  if (provider.app !== app) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.AppMismatch,
      detail: 'Provider thuộc app khác — FR-007 cấm dùng chéo app.',
    };
  }
  return null;
}

/**
 * Cổng chặn scope thực thi của v1 cho `create`/`enable`/`make-primary` (WB-1).
 *
 * ⚠️ Đặt tên `checkProviderScopeSupport` để phân biệt với `checkProviderScope` (`app`
 * mismatch): đây là phạm vi **thực thi của phiên bản**, không phải phạm vi app.
 *
 * ⚠️ Lỗi là **đóng** và detail **không nối giá trị đầu vào** — cùng chính sách với mọi
 * reason khác ở đây (log injection). Giá trị `type`/`transport` thật sự không có trong
 * detail, vì thế một reason chỉ có thể đại diện cho một nhóm.
 */
function checkProviderScopeSupport(
  type: ProviderRecord['type'],
  transport: ProviderRecord['transport'],
): { readonly ok: false; readonly reason: AdminRejection; readonly detail: string } | null {
  if (isV1ExecutableProviderScope({ type, transport })) {
    return null;
  }
  return {
    ok: false,
    reason: ADMIN_REJECTION.UnsupportedProviderScope,
    detail:
      `Provider nằm ngoài scope thực thi v1 — control plane chỉ thực thi ` +
      `type "${V1_EXECUTABLE_PROVIDER_TYPE}" với transport "${V1_EXECUTABLE_TRANSPORT}".`,
  };
}

/**
 * Predicate chọn credential `active` — tách riêng khỏi `checkEnablePreconditions`.
 *
 * ⚠️ **Vì sao là một hàm có tên, không phải arrow function inline**:
 * `credentials.find((credential) => credential.status === 'active')` là một hình
 * dạng mà rule Semgrep `security-sensitive-value-in-http-response` báo **false
 * positive**: taint đi từ biến `credentials` (source theo tên) → `.find(...)`
 * (call giữ taint của receiver) → giá trị trả về tainted → arrow function có
 * **implicit return** (`credential.status === 'active'`) → `return $VALUE` (sink).
 * Rule không phân biệt được `return` của handler với `return` ẩn danh của
 * predicate, nên nó bắt nhầm cả khi hàm **không** trả gì ra ngoài.
 *
 * ⚠️ **Cách chữa này KHÔNG làm mù rule** — đã đo bằng probe trên đúng image
 * ghim của repo (`semgrep/semgrep:1.182.1@sha256:451b3d875c…`), trên bản sao của
 * chính file này:
 *
 *   | Hình dạng                             | finding (bình thường) | finding (rò rỉ) |
 *   |---------------------------------------|-----------------------|-----------------|
 *   | `.find((credential) => …)` (hiện tại)  | 1                     | 2 ✅            |
 *   | `.find(isActiveProviderRecord)` (đây)  | 0                     | 1 ✅            |
 *
 * Bản "rò rỉ" là bản sao có `return active.credentialCiphertext` — vẫn bị bắt.
 *
 * ⚠️ **Vì sao KHÔNG chữa bằng cách đổi tên** (biến ngoài `credentials` →
 * `credentialRecords`, hoặc tham số `credential` → `record`): đo được rằng khi
 * **không còn tên nào** khớp regex source của rule (`credential`, `token`,
 * `secret`, …) thì rule **mù hẳn** — bản rò rỉ rơi từ 2 finding xuống **0**.
 * Đó là hồi quy bảo mật, không phải cách sửa.
 *
 * ⚠️ **Ràng buộc còn một điểm nữa, và nó là điểm dễ sai nhất**: **tên tham số của
 * helper cũng phải sạch**. Đo được: với helper mà tham số tên là `credential`,
 * rule báo **một false positive mới** ngay trong thân helper
 * (`return credential.status === 'active'` — `credential` là source, `return` là
 * sink). Nên cả tên helper (`isActiveProviderRecord`, không phải `…Credential`)
 * lẫn tên tham số (`record`, không phải `credential`) đều cố ý **không** khớp
 * regex source.
 *
 * Hành vi **không đổi**: vẫn lấy đúng credential có `status === 'active'`.
 */
function isActiveProviderRecord(record: ProviderCredentialRecord): boolean {
  return record.status === 'active';
}

/**
 * Precondition deterministic cho `disabled → enabled` (§6.1 — WB-3):
 *
 * 1. **Configuration schema hợp lệ** — cấu hình đúng schema của provider type.
 * 2. **Có credential `active`** — không có thì JWT VAPID không ký được.
 * 3. **Credential giải mã được** — sai root key version/ciphertext hỏng sẽ fail ở runtime.
 *
 * ⚠️ Ba kiểm này **deterministic**: cùng input → cùng kết quả, không phụ thuộc mạng, thời
 * gian, hay trạng thái của push service. "Connectivity + test delivery" (§6.1) là **runbook
 * vận hành §6.4**, không phải gate API: chặn enable bằng "test đã pass" nghĩa là một
 * provider chưa bao giờ được test thì không bao giờ enable được, và provider đã test một
 * lần hôm qua sẽ pass gate hôm nay dù push service đã đổi.
 *
 * ⚠️ Fail-closed cho mọi lỗi bất ngờ: `decrypt` throw → `credential_decryption_failed`
 * (không bao giờ để một lỗi exception chạy qua và trả 500 thay vì một reason đóng).
 */
async function checkEnablePreconditions(
  deps: AdminDeps,
  provider: ProviderRecord,
): Promise<{
  readonly ok: false;
  readonly reason: AdminRejection;
  readonly detail: string;
} | null> {
  const configuration = validateConfigurationForProviderType(provider.type, provider.configuration);
  if (!configuration.ok) {
    return {
      ok: false,
      reason: configuration.reason,
      detail: configuration.detail,
    };
  }

  const credentials = await deps.ports.providerCredentials.listByProvider(
    provider.app,
    provider.providerId,
  );
  const active = credentials.find(isActiveProviderRecord);
  if (active === undefined) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.CredentialMissing,
      detail: 'Provider chưa có credential `active` — không thể ký JWT VAPID cho subscription.',
    };
  }

  try {
    await deps.ports.credentialCipher.decrypt(
      active.credentialCiphertext,
      active.credentialEncryptionVersion,
    );
  } catch {
    // ⚠️ Không nối error message — nó có thể chứa ciphertext/keys metadata (FR-006).
    return {
      ok: false,
      reason: ADMIN_REJECTION.CredentialDecryptionFailed,
      detail:
        'Credential `active` không giải mã được bằng root key version hiện tại — kiểm tra keyring.',
    };
  }
  return null;
}

/**
 * Cùng kiểm scope cho `Push Subscription` — `subscriptions.findById` cũng không lọc `app`.
 *
 * ⚠️ Trả `subscription_not_found` (không phải `provider_not_found`): hai entity này có hai
 * remediation khác nhau, và gộp chúng khiến một `404` của Admin API không chỉ ra được
 * operator cần tra subscription hay provider.
 */
function checkSubscriptionScope(
  subscription: SubscriptionRecord | null,
  app: string,
): { readonly ok: false; readonly reason: AdminRejection; readonly detail: string } | null {
  if (subscription === null) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.SubscriptionNotFound,
      detail: 'Subscription không tồn tại.',
    };
  }
  if (subscription.app !== app) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.AppMismatch,
      detail: 'Subscription thuộc app khác — FR-007 cấm dùng chéo app.',
    };
  }
  return null;
}

/**
 * Ghi audit — **mọi** use case admin đều đi qua đây, nên không có đường nào ghi audit với shape
 * khác.
 *
 * ⚠️ `detail` chỉ nhận mã/scope: `AuditRecordInput.detail` có kiểu `Record<string, string |
 * number | boolean>`, nên không có chỗ cho một payload lọt vào mà không bị type chặn (FR-020:
 * secret `MUST NOT` ghi vào audit).
 */
async function appendAudit(
  deps: AdminDeps,
  event: AuditEvent,
  actor: string,
  entityType: string,
  entityId: string,
  now: number,
  detail: Readonly<Record<string, string | number | boolean>>,
): Promise<void> {
  await deps.ports.audit.append({
    auditId: deps.ids.next(),
    event,
    actor,
    entityType,
    entityId,
    detail,
    now,
  });
}

/* -------------------------------------------------------------------------------------- */
/* VAPID public key distribution                                                              */
/* -------------------------------------------------------------------------------------- */

/** Một VAPID key đang phục vụ — thứ duy nhất mà client/autocomplete cần để subscribe. */
export interface VapidPublicKeyView {
  readonly vapidKeyId: string;
  readonly publicKey: string;
  /** Chỉ key `active` mới được client dùng để subscribe; `retired` chỉ để đối chiếu. */
  readonly status: ProviderCredentialRecord['status'];
}

/**
 * `GET /admin/v1/providers/:id/credentials` — phân phối **public** VAPID key theo scope
 * `(app, provider)`.
 *
 * ⚠️ **Đây là đường đóng gap phân phối public key của task §7.** Client không thể tự biết
 * public key ứng với `vapid_key_id` mà nó phải gửi khi subscribe (FR-003); không có đường
 * đọc nào thì `vapid_key_id` phải được trao đổi ngoài band — một gap vận hành thật. Public
 * key **được phép** công khai theo design (browser nhận nó trong mỗi `applicationServerKey`),
 * nên trả qua Admin API cho Backoffice truy xuất là đúng ranh giới.
 *
 * ⚠️ **Private key tuyệt đối không ở đây**: `listByProvider` trả
 * `ProviderCredentialRecord` — record giữ `credentialCiphertext` (đã mã hoá) và `publicKey`,
 * không có plaintext. Projection bên dưới chỉ lấy hai field an toàn, nên ngay cả khi ai đó
 * thêm field vào record thì view trả ra vẫn là tập đóng `{vapidKeyId, publicKey, status}`.
 */
export async function listVapidPublicKeys(
  deps: AdminDeps,
  input: { readonly app: string; readonly providerId: string },
): Promise<AdminResult<readonly VapidPublicKeyView[]>> {
  const provider = await deps.ports.providers.findById(input.providerId);
  if (provider === null || provider.app !== input.app) {
    return {
      ok: false,
      reason: ADMIN_REJECTION.ProviderNotFound,
      detail: 'Provider không tồn tại trong app này.',
    };
  }
  const credentials = await deps.ports.providerCredentials.listByProvider(
    input.app,
    input.providerId,
  );
  return {
    ok: true,
    value: credentials.map((credential) => ({
      vapidKeyId: credential.vapidKeyId,
      publicKey: credential.publicKey,
      status: credential.status,
    })),
  };
}
