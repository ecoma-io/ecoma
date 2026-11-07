# Backoffice — Application Architecture

`backoffice` là **composition: UI quản trị + BFF** phục vụ vận hành nội bộ. Nó phối hợp các API của các bounded context — Staff Access cho nhân sự/quyền, Pact Broker và Remote Cache cho nghiệp vụ sản phẩm. **Không sở hữu database nghiệp vụ** là target architecture: việc Staff Access tiếp quản staff/RBAC đã được chốt bằng ADR-0013 (supersede phạm vi tương ứng của A21). Khi chuyển xong, composition không ghi database nghiệp vụ thay cho bất kỳ domain nào.

> Business semantics staff/RBAC/entitlement/audit thuộc [`docs/domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md); tài liệu này chỉ mô tả composition UI/BFF và trỏ về Domain Model.

## 1. Composition và ranh giới runtime

- **Component type:** composition (UI/BFF).
- **Runtime boundary:** `apps/backoffice` (Nuxt/Nitro) + BFF server-side; trình browser chỉ thấy session cookie (`__Host-backoffice-session` — session ID nguyên vẹn), server lưu `id_hash = SHA-256(id)` trong `bff_sessions` (hash-only ở phía lưu trữ, không phải phía cookie).
- **Không sở hữu database nghiệp vụ:** composition không ghi database nghiệp vụ thay cho bất kỳ domain nào; mọi dữ liệu nghiệp vụ đi qua API của context sở hữu.

## 2. Application flow và orchestration

1. Browser → GET `/api/staff`, `/api/onboarding-status`, `/api/me` → backoffice BFF (sau `requirePrincipal`, chỉ staff đã đăng nhập).
2. BFF đọc `displayName` từ contract `GET /internal/account/profiles` của `account` (displayName là dữ liệu hồ sơ thuộc `account`; `backoffice` không lưu bản sao bền vững, chỉ cache và đọc qua contract).
3. UI visibility ẩn nút/route/menu là trải nghiệm, không phải chốt chặn; gọi trực tiếp API vẫn bị từ chối nếu không authorize.
4. Onboarding staff: gate displayName (§2.1), chỗ gắn gate 2FA (giai đoạn 2, chưa cài đặt).
5. Privileged-operation workflow: phê duyệt và thực thi thao tác vận hành nhạy cảm, audit append-only.

### 2.1 Onboarding staff và gate displayName

`displayName` là dữ liệu hồ sơ thuộc `account`; BFF không giữ bản sao bền vững, chỉ đọc qua contract profiles và cache trong bộ nhớ. Khi một staff member chưa đặt tên, sổ staff không còn tên để hiển thị và cần một đường onboarding rõ ràng.

```text
Browser ──► GET /api/staff ──────────────► backoffice BFF ──► GET /internal/account/profiles?subs=… ──► account
                   ▲                                            │                                        (db-account)
Browser ──► GET /api/onboarding-status ──► backoffice BFF ────────┘
Browser ──► GET /api/me ─────────────────► (cùng client + cache)
Browser ──► GET /onboarding ─────────────► onboarding page (đọc /api/onboarding-status)
```

- Cả ba route BFF chạy **sau** `requirePrincipal`; `sub` của principal là khoá tra cứu duy nhất. `/api/me` trả `{ sub, displayName | null }` của phiên hiện tại. `account` chỉ trả các `sub` được hỏi; entry thiếu và `displayName: null` đều nghĩa là **chưa đặt tên**.
- **Hai chế độ lỗi, vì rủi ro khác nhau:**

  | Route                        | Vai trò khi đọc lỗi                        | Chính sách                                   | Lý do                                                                                                 |
  | ---------------------------- | ------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
  | `GET /api/onboarding-status` | Đầu vào của **gate** quyết định onboarding | **Fail-closed** → 503                        | Là gate bảo mật-hướng: trả `false` khi không verify được sẽ cho người chưa đặt tên lọt qua onboarding |
  | `GET /api/staff`             | Chỉ **trang trí** cột displayName          | **Controlled degrade** → `displayName: null` | Thiếu tên không làm mất chức năng nào của sổ staff; chặn cả trang vì một cột phụ là trả giá quá lớn   |
  | `GET /api/me`                | Danh tính **hiển thị** của phiên hiện tại  | **Controlled degrade** → `displayName: null` | Cùng bản chất hiển thị với `/api/staff`; UI có label riêng cho trạng thái trống                       |

- Degrade **không im lặng**: mỗi lần degrade ghi log event `staff.account_degraded` (hoặc `me.account_degraded`) kèm reason từ client (`binding_missing` / `secret_missing` / `unreachable` / `http_error` / `invalid_response`). Event tách nhau để đo được tỉ lệ degrade của từng bề mặt. Cả ba route dùng chung một client, nên một cấu hình sai hiện lên ở cả ba — đúng ý, không có đường nào "vẫn chạy như cũ" với dữ liệu không verify được.
- **Cache:** module-level trong process BFF, TTL 120 giây, key `sub`, dùng chung cho cả ba route. Không có store bền vững và không có cross-instance invalidation — TTL ngắn là toàn bộ biên độ stale chấp nhận được. Giá trị `null` **có** được cache nhưng với **expiry tuyệt đối**: một hit không kéo dài tuổi thọ entry, nên người vừa đặt tên ở `account` không bị kẹt trong onboarding quá một TTL. Cache chỉ là tối ưu hiệu năng: hit hay miss không đổi kết quả quyết định.
- **Không fallback theo email.** Email không phải tên hiển thị, không phải primary identity key và không phải quan hệ 1:1 do `backoffice` sở hữu; suy tên từ email tạo nhãn sai mà người dùng không sửa được từ `backoffice`, và che mất dữ liệu thật với cả người đọc lẫn telemetry. Thay vào đó UI hiển thị trạng thái trống rõ ràng (label i18n `onboarding.noDisplayName`) và trỏ về `account` để tự đặt tên.
- **Gate two-factor (giai đoạn 2 — chưa cài đặt).** Placeholder trong `apps/backoffice/app/pages/onboarding.vue` (`data-testid="onboarding-mfa"`) sẽ được thay bằng trạng thái enrolment TOTP thật đọc từ BFF; khi bật, nút "tiếp tục" thành checkpoint bắt buộc. Gate này thêm yêu cầu lên principal, **không** thêm trường vào contract profiles và không đổi chính sách hai route ở trên; điều kiện assurance theo [ADR-0005](../../domains/staff-access/adr/0005-step-up-fresh-session.md).
- **Cấu hình liên quan:**

  | Key                                                 | Loại            | Ý nghĩa                                                                                     |
  | --------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
  | `ACCOUNT_SERVICE` (binding, `ecoma-account-bridge`) | Service Binding | Đường gọi contract profiles. **Không** phải xác thực — envelope HMAC mới là lớp xác thực.   |
  | `AUTH_INTERNAL_SECRET`                              | Secret          | Chia sẻ với `account` để ký/xác minh envelope; rỗng/vắng → mọi call bị coi là chưa cấu hình |
  | `NITRO_PUBLIC_BACKOFFICE_ACCOUNT_PROFILE_URL`       | Cấu hình public | Origin + path trang profile của `account` để link từ onboarding; rỗng/vắng → **ẩn link**    |

  Việc cấp binding và secret cho từng môi trường thuộc tầng deployment, không thuộc `apps/backoffice`.

## 3. API/protocol surfaces

- BFF routes: `/api/staff`, `/api/onboarding-status`, `/api/me`, `/onboarding` (page đọc `/api/onboarding-status`).
- Internal contract: `GET /internal/account/profiles` của `account` qua Service Binding `ecoma-account-bridge` + envelope HMAC (signature + timestamp + nonce).
- Authn boundary: principal lấy từ server-side verified token (`sub` là khóa tra cứu), không từ request body/param.

## 4. Integrations và adapters

- `staff-access`: tiêu thụ nhân sự/quyền/entitlement qua contract (trỏ [`docs/domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md)).
- `account`: tiêu thụ displayName qua contract profiles (dữ liệu hồ sơ thuộc `account`).
- `auth`: verify token, internal HMAC envelope.
- `pact-broker`, `remote-cache`: nghiệp vụ sản phẩm (composition gọi API của các context này).

## 5. Persistence implementation

- `bff_sessions`: lưu `id_hash = SHA-256(id)` (hash-only), không lưu session ID nguyên vẹn ở phía lưu trữ.
- Không lưu bản sao bền vững của `displayName` (chỉ cache module-level TTL 120s, key `sub`).

## 6. Runtime security

- Authentication qua `account`/`auth` như mọi application; token hợp lệ không phải bằng chứng privilege còn hiện hành (A24).
- Authorization deny-by-default, enforce ở resource-owning backend; UI visibility không phải authorization (A23).
- Server-side enforcement trên mọi protected request; object-level + scope-level check.
- Internal contracts dùng envelope HMAC; vị trí mạng nội bộ không phải trust.
- Confused deputy: BFF không hành động thay identity chưa xác minh; principal từ server-side verified token.

## 7. Execution/failure model

- Chính sách lỗi khi đọc `displayName` (fail-closed cho gate, controlled degrade cho bề mặt hiển thị, log event, cache, không fallback theo email) → §2.1.
- Cache displayName là tối ưu hiệu năng, không phải correctness: hit/miss không đổi kết quả quyết định (system invariant 12 — không correctness nào phụ thuộc state isolate-global).

## 8. Dependency trên Domain contexts

- `staff-access` (nhân sự/quyền/entitlement/audit — trỏ [`docs/domains/staff-access/domain-model.md`](../../domains/staff-access/domain-model.md)).
- `account` (tiêu thụ displayName, không mutates dữ liệu staff/RBAC).
- `auth` (verify token, HMAC envelope).
- `pact-broker`, `remote-cache` (nghiệp vụ sản phẩm).

## 9. Application-level invariants

- UI visibility ≠ authorization.
- `account`/`auth` không ghi dữ liệu staff/role/permission của `staff-access`.
- Token validity ≠ privilege currency.
- Authorization audit append-only, access-restricted, không chứa secret/token/PII.
- Staff status và account status là hai trục độc lập.
