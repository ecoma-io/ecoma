# cross-product-journey-e2e

## Purpose

Suite system E2E **cross-product chained journey** — lõi Outcome của issue
[#27](https://github.com/ecoma-io/ecoma/issues/27): một chuỗi liền mạch đi qua
bốn sản phẩm MVP trên stack local thật, chứng minh các sản phẩm hoạt động cùng
nhau như một nền tảng chứ không phải bốn dịch vụ rời rạc.

## Responsibilities

- Chạy chuỗi 4 bước qua UI thật, CLI thật và data-plane thật — không launcher
  trung gian, không mock HTTP (bảng "Chuỗi" bên dưới).
- Assert các negative case: credential thiếu/sai bị từ chối trên mọi bề mặt,
  isolation hai chiều giữa tenant `ecoma` và tenant fixture, leak fence cho
  plaintext key và prompt body.
- Giữ stack gate fail-closed: stack vắng mặt là kết quả ĐỎ, không bao giờ skip.

## Boundaries

- Suite KHÔNG sửa bất kỳ ứng dụng, thư viện hay deploy nào; chỉ kiểm từ ngoài.
- Đọc DB chỉ ở một kênh duy nhất đã phê duyệt cho #27: test-observer read-only
  (`docker exec psql`) cho assertion settlement của bước 4 — không seed DB của
  llm-gateway, không thêm API accounting public.
- Seed DB (`e2e/support/stack-fixtures.ts`) chỉ tạo dữ liệu fixture của suite
  (identity account, membership tenant) — lớp first-party đến từ bootstrap thật
  của `local-up`.
- KHÔNG test payment, streaming, LLM Console UI — non-goals của M1.

## Chuỗi

| Bước | Sản phẩm     | Bằng chứng                                                                                                                                                |
| ---- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Backoffice   | Superadmin bootstrap thật (`superadmin@ecoma.io`) đăng nhập qua OIDC/OTP UI thật; `/api/me` trả 200 với principal                                         |
| 2    | Remote Cache | Token lấy qua control plane đã xác thực (portal UI show-once); Nx CLI thật PUT artifact → HIT từ container sạch thứ hai trên platform network             |
| 3    | Pact Broker  | Developer credential tạo qua portal UI publish bằng Pact CLI thật; CI credential riêng chạy verifier thật rồi `can-i-deploy` YES                          |
| 4    | llm-api      | Inference thật qua worker trong network với consumer key bootstrap; usage settle đúng một lần — replay cùng `x-request-id` trả 409 và không double charge |

Mỗi bước lấy credential của sản phẩm kế bằng phiên/credential của bước trước —
không launcher trung gian; mỗi portal xác thực riêng bằng cơ chế OIDC của chính
nó.

## Negative assertions

- **Credential thiếu/sai bị từ chối** trên mọi bề mặt: data-plane Remote Cache
  (401), machine API Pact (401), Backoffice `/api/**` (401), llm worker
  (401 `invalid_api_key`).
- **Isolation hai chiều** giữa tenant `ecoma` và tenant fixture thứ hai: portal
  (403/200 tách bạch), data-plane Remote Cache (hash của tenant A là miss với
  key tenant B), Pact Broker (cùng tên pacticipant, mỗi tenant chỉ nhìn thấy
  nội dung của mình).
- **Leak fence**: plaintext key consumer và trusted-CI key không bao giờ nằm
  trong output suite, log container, hay message assert; prompt body không nằm
  trong log worker/mock.

## Test-observer (kênh assertion accounting)

Settlement assertion của bước 4 đọc database read-only qua `docker exec psql`
(`db-llm-gateway`: `llm_gateway.logical_requests`, `llm_financial.customer_charges`)
— **kênh này đã được phê duyệt cho #27** trong thiết kế của issue (nhận xét
được duyệt ngày 2026-11-17): không có API accounting public và suite không thêm
một cái nào. Suite CHỈ ĐỌC — mọi truy vấn là `SELECT`; không seed, không
migration, không vòng đời container.

## Testing

```sh
pnpm nx run cross-product-journey-e2e:system-test -c local
pnpm nx run cross-product-journey-e2e:typecheck
```

Target `system-test` đi qua runner `bin/run-system-test.mjs`: đọc trạng thái
lane (`lane.ts state` của `deploys/llm-api-deploy`) để lấy consumer key, chạy
Playwright, và chặn rò rỉ plaintext key ra output. Chạy Playwright trực tiếp
(bỏ qua runner) sẽ fail-closed vì thiếu env `LLM_E2E_*`. Stack phải sống trước
khi chạy — gate fail-closed trong `global-setup.ts` sẽ làm suite ĐỎ nếu stack
vắng mặt.

## Related Documentation

- `docs/architecture/06-testing.md` — phân tầng test và placement của system-test.
- `docs/engineering/contribution-workflow.md` — quy trình chạy validation.
- `system-tests/e2e/remote-cache-portal-e2e/`, `system-tests/e2e/pact-broker-portal-e2e/`,
  `system-tests/e2e/backoffice-access-control-e2e/` — suite skeleton gốc.

## Development

Cấu trúc: `bin/run-system-test.mjs` (runner: lane state → env → playwright →
fence), `global-setup.ts` (stack gate fail-closed), `playwright.config.ts`
(Chromium với SPKI pin của cert local — không `ignoreHTTPSErrors`; config
không bao giờ throw), `e2e/cross-product-chain.spec.ts` (chuỗi serial, một
worker) và `e2e/support/` (origin/stack-env, luồng OIDC browser, DB fixture
seeding, network helper).

Suite copy skeleton của `remote-cache-portal-e2e`, `pact-broker-portal-e2e`,
`backoffice-access-control-e2e` và `llm-inference-e2e` — không import chéo giữa
các suite (mỗi suite tự sở hữu support, `docs/architecture/06-testing.md` §2).

## Cấu trúc

- `bin/run-system-test.mjs` — runner: lane state → env → playwright → fence.
- `global-setup.ts` — stack gate fail-closed: probe hợp đồng unauthenticated
  401 của Backoffice và portal Remote Cache trước khi suite chạy.
- `playwright.config.ts` — Chromium với SPKI pin của cert local (không
  `ignoreHTTPSErrors`); config không bao giờ throw.
- `e2e/cross-product-chain.spec.ts` — chuỗi serial (một worker) + hai test
  negative.
- `e2e/support/` — origin/stack-env, OIDC flow dùng chung, DB fixture seeding
  (dữ liệu fixture của suite; lớp first-party đến từ bootstrap thật của
  `local-up`), network helper.

Suite copy skeleton của `remote-cache-portal-e2e`, `pact-broker-portal-e2e`,
`backoffice-access-control-e2e` và `llm-inference-e2e` — không import chéo giữa
các suite (mỗi suite tự sở hữu support, `docs/architecture/06-testing.md` §2).
