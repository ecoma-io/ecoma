# Backoffice Access Control E2E

Suite system test (`@ecoma-io/backoffice-access-control-e2e`) verify năng lực **kiểm soát truy cập của backoffice** trên stack local đang chạy thật: luồng OIDC browser đầy đủ đi qua `auth` và `account`, rồi mọi lớp access control của BFF — denial chưa đăng nhập, permission enforcement theo assignment, logout thu hồi session.

Theo `docs/architecture/06-testing.md` §3, đây là **system test** — verify cả hệ thống nhiều deploy unit, không phải test của một app đơn lẻ; suite nằm dưới `system-tests/e2e/` với project config, setup, support riêng (§2). Nx tags `type:tooling`, `scope:backoffice`, `runtime:native`.

## Purpose

- Chứng minh access control được kiểm tra ở server, không ở trình duyệt: mọi `/api/**` của BFF trả 401 cho caller chưa xác thực, 403 khi thiếu permission, 200 khi có, và trở lại 403 ngay khi assignment bị thu hồi — không cần relogin.
- Chứng minh luồng đăng nhập browser end-to-end chạy thật qua ba origin: kickoff của BFF → authorize của `auth` → trang login OTP của `account` → consent → callback → session server-side.
- Chứng minh vòng đời session: logout với CSRF double-submit thu hồi phiên phía server, không chỉ xoá cookie.

## Responsibilities

- **`login-kickoff.spec.ts`** — `GET /api/auth/login` trả 302 tới authorize với bộ tham số OIDC đầy đủ; cookie `__Host-backoffice-login` dùng một lần với đủ cờ; hai lần kickoff sinh `state` và PKCE challenge khác nhau (không replay flow value).
- **`authenticated-access.spec.ts`** — login browser đầy đủ qua `auth`/`account` land lại backoffice với session; hop callback cuối trả 302 (đổi token và ghi session thành công); `/api/me` trả 200 với `sub` của principal; trang overview render ba area link (UI smoke, không assert nghiệp vụ).
- **`permission-enforcement.spec.ts`** — đã đăng nhập nhưng không có staff row/assignment ⇒ 403 trên `/api/staff`; seed role + `role_permissions('staff.read')` + assignment + staff row active ⇒ 200 listing từ Staff Access API; thu hồi assignment phía server (`revoked_at`) ⇒ 403 trở lại mà không relogin.
- **`logout.spec.ts`** — login một lần rồi logout với cặp CSRF xoá cookie và giết session phía server; logout không cookie là 204 idempotent.
- **`unauthenticated-denial.spec.ts`** — năm route `/api` (staff, roles, permissions, me, onboarding-status) đều trả 401 khi chưa đăng nhập.
- **Stack gate fail-closed** (`global-setup.ts`): probe `GET /api/staff` không cookie phải trả 401 — hợp đồng nhận diện stack đã có wiring BFF OIDC; 503 fail-closed của app (stack predates wiring) fail tức thời với message redeploy, không retry.
- **Fixture layer** (`e2e/support/`): spec file cần login giữ một định danh riêng (`authenticated-access`, `logout`, `permission-enforcement` trong `fixtures.ts`) để hai worker song song không chia sẻ session/grant/mail sink; seed idempotent vào `db-account`, `db-backoffice` (staff, role, role_permission, assignment) và `db-staff-access` qua `docker exec psql`; đọc OTP từ mail sink D1; helper `performBrowserLogin` điều khiển UI với retry chỉ cho trang "chưa sẵn sàng".

## Boundaries

- Suite không phải browser regression của UI backoffice — nó verify hành vi access control qua serving path thật; test app-owned của backoffice nằm dưới `apps/backoffice/tests/` (`integrations/`, `databases/`) theo `docs/architecture/06-testing.md` §2.
- `implicitDependencies` khai sáu deploy unit mà kết quả test phụ thuộc: `platform-deploy`, `backoffice-deploy`, `auth-deploy`, `account-deploy`, `transactional-mail-deploy`, `staff-access-deploy`. Không khai `home-deploy`, `pact-broker-*`, `push-notification-*`: suite không chạm origin nào của chúng.
- Truy cập nội bộ stack qua Docker CLI chỉ dành cho seed fixture và đọc mail sink; mọi assertion đi qua Traefik như black-box.
- Dữ liệu: seed idempotent (`ON CONFLICT DO NOTHING`, riêng `staff_access.staff` là `DO UPDATE`); seed xoá OTP challenge của đúng hash địa chỉ fixture trước mỗi challenge (budget rate limit dính lại giữa các lần rerun); suite không DELETE staff/role/assignment — thu hồi quyền là `UPDATE revoked_at`, schema giữ audit; fixture còn lại cho tới khi stack local bị dọn.

## Development

- Thêm spec mới: cấp một định danh fixture riêng trong `e2e/support/fixtures.ts` — Playwright chạy file song song (`workers: 2`), định danh dùng chung làm hai worker va chạm grant và mail sink.
- Phần contract logout/kickoff dùng request Node với `CookieJar` (không browser) — logout là hành vi HTTP thuần; browser chỉ cần để lấy cặp cookie thật.
- `playwright.config.ts` không throw khi thiếu `ROOT_HOST` — trả origin `office.<root>.invalid` vô hại (origin không thể route); fail-closed thật nằm ở `global-setup.ts` với message nêu remedy.
- Cấu hình chạy: `workers: 2`, `retries: 0` kể cả CI, timeout 60s; mỗi file tự đi luồng login riêng (không chia sẻ `storageState` — session server-side dùng chung là đường che bug `bff_sessions`).

## Testing

Target canonical là `system-test` (`docs/architecture/06-testing.md` §4), suite tự định nghĩa thực thi; `cache: false` có chủ đích — stack local là external state sống ngoài inputs của Nx.

```bash
pnpm nx run @ecoma-io/backoffice-access-control-e2e:system-test -c local
```

- `dependsOn` kéo `local-up` của đúng sáu deploy project mà suite phụ thuộc trước khi Playwright chạy — một invocation tự dựng đủ stack; `-c local` lan configuration vào task prerequisite.
- Prerequisites: sáu deploy unit trên đang up; `ROOT_HOST` qua env hoặc `.env` repo root (platform `local-up` ghi giá trị); cert local `deploys/platform-deploy/local-certs/fbi.com.crt`; client `ecoma-backoffice-local` với redirect_uri `office.<host>` do chính `local-up` của `auth` seed.
- 17 test trong 5 file spec.
- Các suite system-test dùng chung một local stack — chạy batch với `--parallel=1` (§4).

## Related Documentation

- [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md) — taxonomy (§3), canonical targets, selection và prerequisite (§4).
- [`docs/features/internal-access/access-protected-staff-resources.md`](../../../docs/features/internal-access/access-protected-staff-resources.md) — capability mà suite verify trên hệ thống chạy thật.
- [`docs/applications/backoffice/README.md`](../../../docs/applications/backoffice/README.md) — thiết kế component của BFF backoffice.
- [`docs/domains/staff-access/README.md`](../../../docs/domains/staff-access/README.md) — ngữ nghĩa nghiệp vụ của context `staff-access`.
- [`docs/architecture/local-development/02-account-auth-topology.md`](../../../docs/architecture/local-development/02-account-auth-topology.md) — topology account/auth mà luồng login đi qua.
- Suite cùng nhóm: [`identity-login-e2e`](../identity-login-e2e/), [`identity-oidc-e2e`](../identity-oidc-e2e/), [`home-public-e2e`](../home-public-e2e/).
