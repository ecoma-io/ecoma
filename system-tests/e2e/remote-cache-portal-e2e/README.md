# remote-cache-portal-e2e

## Mục đích

System E2E suite cho journey portal `remote-cache-app` trên stack local thật —
đóng vấn đề "portal + Nx CLI e2e compat chưa bao giờ được verify" (issue #299,
một phần của #27 journey 2). Suite chạy browser thật (Playwright Chromium), CLI
thật (`nx` 23.3.2 từ npm registry) và data-plane thật của `remote-cache-api`,
không mock HTTP nào.

## Trách nhiệm

- Verify các điều kiện chấp nhận của portal (A27, A29, A30, A31, A32):
  tạo project qua UI, key đầu tiên show-once đúng một lần, metadata không lộ
  secret, revoke có hiệu lực tức thời trên data plane, key developer (untrusted)
  PUT bị 403, người ngoài tenant bị từ chối fail-closed.
- Verify journey Nx CLI thật: `nx run` với `NX_SELF_HOSTED_REMOTE_CACHE_SERVER`
  - trusted-CI key của lane phải store và retrieve cache trên lane.
- Giữ stack gate fail-closed: stack vắng mặt là kết quả ĐỎ, không bao giờ skip.

## Ranh giới

- Suite KHÔNG sửa bất kỳ ứng dụng, thư viện hay deploy nào; chỉ kiểm từ ngoài.
- KHÔNG assert bằng cách đọc DB — DB chỉ phục vụ seed fixture (identity account,
  membership tenant) trong `e2e/support/stack-fixtures.ts`.
- KHÔNG test quota 429, hết hạn key, hosted lane, hay route/flag sản phẩm thêm
  vào chỉ để test (non-goals của issue #299).
- Data-plane chỉ với tới được TỪ TRONG docker network (`remote-cache-api` không
  có router Traefik, quyết định #238): mọi assertion data-plane chạy `curl` /
  `nx` trong container dùng chung network với stack.

## Phát triển

Cấu trúc: `playwright.config.ts` (SPKI pin cho cert local, không
`ignoreHTTPSErrors`), `global-setup.ts` (gate fail-closed — probe
`GET /api/portal/tenants/ecoma/projects` không đăng nhập phải 401),
`e2e/support/` (origin + TLS scoped, fixtures seed DB, luồng OIDC browser,
đọc OTP từ mail sink), `e2e/*.spec.ts` (journey).

Suite copy skeleton của `backoffice-access-control-e2e` và giữ nguyên các quyết
định đã kiểm chứng ở đó: retry chỉ cho chữ ký "chưa sẵn sàng", `retries: 0`,
`workers: 2`, không `webServer`.

## Kiểm thử

```sh
pnpm nx run remote-cache-portal-e2e:system-test -c local
pnpm nx run remote-cache-portal-e2e:typecheck
```

Target `system-test -c local` tự động lên các prerequisite `local-up` (platform,
remote-cache-app/api, auth, account, transactional-mail). Stack phải sống trước
khi chạy — gate fail-closed trong `global-setup.ts` sẽ làm suite ĐỎ nếu stack
vắng mặt.

## Tài liệu liên quan

- `docs/architecture/06-testing.md` — phân tầng test và placement của system-test.
- `docs/engineering/contribution-workflow.md` — quy trình chạy validation.
- `system-tests/e2e/backoffice-access-control-e2e/` — suite skeleton gốc.
- Issue #299 — phạm vi và non-goals của suite này.
