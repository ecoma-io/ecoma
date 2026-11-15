# pact-broker-portal-e2e

## Mục đích

Suite system E2E kiểm journey developer/CI của portal `pact-broker-app` trên
stack local thật (issue #300, đối chiếu #27 journey 3 và các hàng PB-1..PB-12
của #7). Suite chứng minh đầu-cuối: login OIDC thật qua Ecoma Account, tạo
machine credential qua UI portal (show-once), publish contract bằng **Pact CLI
thật** `@pact-foundation/pact-cli@18.10.9`, contract hiển thị trong UI, publish
verification result + `can-i-deploy` bằng CI credential, revoke có hiệu lực
ngay, và isolation hai chiều giữa hai tenant.

Suite này KHÔNG nhân bản các machine-path credential scenario đã có ở
integration của `pact-broker-api` — giá trị của nó là portal UI thật + OIDC
login thật + Pact CLI thật trên lane.

## Trách nhiệm

- Chứng minh PB-4/PB-10: Developer credential tạo qua UI dùng publish contract
  bằng Pact CLI thật (không phải payload mô phỏng).
- Chứng minh PB-12: contract hiển thị đúng trên pacts page sau publish.
- Chứng minh PB-5/PB-11: CI credential tạo qua UI dùng publish verification
  result và `can-i-deploy` trả lời YES.
- Chứng minh PB-8: revoke credential qua UI → request kế tiếp bằng secret cũ
  bị từ chối ngay (401 đồng nhất).
- Chứng minh PB-9: isolation hai chiều — cùng tên pacticipant hai tenant,
  nội dung khác nhau, mỗi tenant chỉ nhìn thấy dữ liệu của mình.
- Fail-closed khi stack không chạy: gate probe trong `global-setup.ts` phải
  thấy đúng hợp đồng unauthenticated 401 của BFF, nếu không suite ĐỎ.

## Ranh giới

- Suite chỉ đọc DB cho **fixture prep** (`account.users`,
  `account.email_addresses`, `pact.tenant_members`, `pact.tenants`) và đọc OTP
  từ mail sink — mọi assertion đều qua API/UI/CLI, không assert trên DB.
- Secret show-once KHÔNG BAO GIỊ bị log hay commit: plaintext chỉ sống trong
  biến process của test và được truyền vào CLI qua biến môi trường.
- Không test webhooks, không test role matrix đầy đủ (đã có ở integration).
- Fixture tenant thứ hai chỉ theo pattern `stack-fixtures.ts` (idempotent,
  `owner_sub` khác chủ first-party, hash-only).
- Không sửa product code để test pass — gap product thật là blocker, không
  phải workaround.

## Phát triển

- Skeleton copy từ `remote-cache-portal-e2e` (#299) — cùng mọi quyết định
  kiến trúc: gate fail-closed, TLS scoped (SPKI pin cho browser, `ca` scoped
  cho Node), identity per test (rate limit OTP 3/15 phút theo địa chỉ).
- Pact CLI chạy từ host: API broker public qua router Traefik
  `Host(api.<root>)`, khác remote-cache (internal-only). TLS của CLI qua
  `SSL_CERT_FILE` trỏ cert local đã commit.
- Provider app cho verifier là HTTP server thật khởi động trong test, trả 200
  JSON trên mọi request — verifier verify interaction thật rồi publish result.
- Binary CLI đến từ devDependency `@pact-foundation/pact-cli@18.10.9` pin
  chính xác (per #205).

## Kiểm thử

```sh
pnpm nx run pact-broker-portal-e2e:system-test -c local
```

Nx kéo `local-up` của sáu deploy project mà suite phụ thuộc trước khi chạy
Playwright (xem `implicitDependencies` trong `package.json`). Typecheck:
`pnpm nx run pact-broker-portal-e2e:typecheck`.

## Tài liệu liên quan

- Issue #300 — design và điều kiện hoàn thành của suite.
- `docs/architecture/06-testing.md` — tầng test và target canonical.
- `apps/pact-broker-api/README.md`, `apps/pact-broker-app/README.md` — hai
  deploy unit được kiểm.
