# Identity Login E2E

Suite system test (`@ecoma-io/identity-login-e2e`) verify năng lực **đăng nhập email-OTP** của app `account` end-to-end trên stack local đang chạy thật: DNS → TLS → Traefik → container account → PostgreSQL → transactional-mail → mail sink D1.

Theo `docs/architecture/06-testing.md` §3, đây là **system test** — verify cả hệ thống nhiều deploy unit, không phải test của một app đơn lẻ; suite nằm dưới `system-tests/e2e/` với project config, setup, fixture riêng (§2). Nx tags `type:tooling`, `scope:account`, `runtime:native`.

## Purpose

- Chứng minh flow OTP login hoạt động qua serving path thật: HTTPS với TLS verify thật (CA scoped cho mọi Node request, SPKI pin cho Chromium — không `ignoreHTTPSErrors`), từ HTTP request tới dữ liệu trong `db-account` và mail sink.
- Suite là assertion thuần API qua Node `https` (`e2e/support/local-origin.ts`); project duy nhất `chromium` giữ SPKI pin cho contract TLS.

## Responsibilities

- **`otp-login-flow.spec.ts`** — `account login OTP flow`: challenge trả 204 im lặng và OTP rơi vào mail sink; verify bằng mã trong mail cấp cặp cookie session; đọc session trả đúng payload; logout với CSRF double-submit thu hồi session server-side.
- **`challenge-anti-enumeration.spec.ts`** — địa chỉ đã verified và địa chỉ lạ trả cùng một bare 204, không lộ tồn tại tài khoản.
- **`verify-negative-paths.spec.ts`** — sai mã không có challenge, địa chỉ chưa từng challenge, body malformed, mã sai trên địa chỉ lạ: đều `400` và không tạo oracle phân biệt.
- **`session-cookie-contract.spec.ts`** — `Set-Cookie` của verify đủ bộ thuộc tính `__Host-`; payload session mang `sub` đã seed và ACR của OTP; logout idempotent (không cookie, cookie của session khác).
- **Stack gate fail-closed** (`global-setup.ts`): trước test đầu tiên, probe `GET /api/auth/session` không cookie phải trả `401` qua đúng chuỗi DNS/TLS/Traefik/upstream; stack không reachable là kết quả đỏ, không bao giờ skip.
- **Fixture layer** (`e2e/support/local-stack.ts`): seed user trực tiếp vào PostgreSQL (không có signup API — fixturization qua dữ liệu), đọc OTP từ mail sink D1 trong container `ecoma-<ns>-mail-wic` qua `docker exec` với `node:sqlite`, trigger cron của worker mail trong vòng poll; mỗi file spec dùng một danh tính fixture riêng `{ sub, email }` để hai worker không đọc nhầm mã của nhau.

## Boundaries

- Suite **không chạm origin `auth`**: `challenge/verify/session/logout` là route của `apps/account`; `implicitDependencies` chỉ khai `platform-deploy`, `account-deploy`, `transactional-mail-deploy`. Luồng OIDC browser qua `auth` là suite riêng `system-tests/e2e/identity-oidc-e2e`.
- Truy cập nội bộ stack qua Docker CLI chỉ dành cho hai khả năng mà protocol công khai không cung cấp: seed user và đọc mail sink; mọi assertion flow đi qua Traefik như black-box.
- Dữ liệu: seed idempotent (`ON CONFLICT DO NOTHING`); cleanup chỉ xoá hàng nhận diện được của suite (theo `sub`, hash địa chỉ fixture, recipient trong sink), không đụng hàng khác của stack.

## Development

- Thêm spec mới: tạo cặp danh tính fixture riêng cho file và lọc truy vấn sink theo `recipient` — `workers: 2` nên hai file chạy song song.
- `playwright.config.ts` không throw khi thiếu `ROOT_DOMAIN`/`ROOT_HOST` (trả placeholder `.invalid`); gate thật nằm ở `global-setup.ts`.
- Helper dùng chung của suite nằm trong `e2e/support/` (`local-origin.ts`, `local-stack.ts`); `lint` chạy oxlint trên toàn project.

## Testing

Target canonical là `system-test` (`docs/architecture/06-testing.md` §4), suite tự định nghĩa thực thi; `cache: false` có chủ đích — stack local là external state sống ngoài inputs của Nx.

```bash
pnpm nx run @ecoma-io/identity-login-e2e:system-test -c local
```

- `dependsOn` kéo `local-up` của đúng ba deploy project mà suite phụ thuộc (`platform-deploy`, `account-deploy`, `transactional-mail-deploy`) trước khi Playwright chạy — một invocation tự dựng đủ stack.
- Prerequisites: ba deploy unit trên đang up; `ROOT_DOMAIN`/`ROOT_HOST` qua env hoặc `.env` repo root (platform `local-up` ghi giá trị); cert local `deploys/platform-deploy/local-certs/fbi.com.crt`.
- Cấu hình chạy: `workers: 2`, `retries: 0` kể cả CI, timeout 60s.
- Các suite system-test dùng chung một local stack — chạy batch với `--parallel=1` (§4).

## Related Documentation

- [`docs/architecture/06-testing.md`](../../../docs/architecture/06-testing.md) — taxonomy (§3), canonical targets, selection và prerequisite (§4).
- [`docs/architecture/local-development/02-account-auth-topology.md`](../../../docs/architecture/local-development/02-account-auth-topology.md) — topology account/auth mà suite đi qua.
- [`docs/architecture/local-development/03-operations.md`](../../../docs/architecture/local-development/03-operations.md) — vận hành stack local.
- Suite cùng nhóm: [`identity-oidc-e2e`](../identity-oidc-e2e/), [`home-public-e2e`](../home-public-e2e/).
- [`apps/account/README.md`](../../../apps/account/README.md) — app là đối tượng verify chính của suite.
