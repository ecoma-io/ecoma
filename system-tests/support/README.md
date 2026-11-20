# System Tests Support

Support dùng chung cho các system-test suite (`@ecoma-io/system-tests-support`): helper điều khiển browser của luồng login OIDC mà nhiều suite cùng tiêu thụ. Hiện nay gói chung chứa pha chờ sau khi bấm `login-code-submit` — pha từng bị nhân bản y hệt vào 4 suite và là gốc của lớp flake A30 (#461 round 2).

Theo `docs/architecture/06-testing.md` §2, support chung ở root `system-tests/` chỉ được tách khi consumer và dependency tường minh: 4 suite được nêu tên dưới đây khai `@ecoma-io/system-tests-support: workspace:*` trong `devDependencies` và import qua điều kiện `@ecoma-io/source` (resolve thẳng `src/index.ts`, cùng cơ chế với `@ecoma-io/deployment`). Nx tags `type:tooling`, `scope:shared`, `runtime:native`.

## Purpose

- Xoá nợ nhân bản: một hợp đồng recovery duy nhất cho pha chờ sau OTP verify thay vì 4 bản copy phải sửa đồng loạt — mọi sửa hành vi chỉ chạm một file.
- Chứng minh logic nhánh của pha chờ bằng unit test thật (vitest với locator giả theo kịch bản), tầng mà suite e2e cold-runner trên CI chỉ chạm khi flake nổ ra.
- Giữ hành vi của 4 suite không đổi: recovery đúng MỘT lượt, chết lần hai vẫn throw kèm stuck state — vòng bị chặn trên `MAX_VERIFY_ATTEMPTS` thay vì chỉ dựa `break`/`throw` nội bộ.

## Responsibilities

- **`src/otp-verify-recovery.ts`** — `waitForContinueTargetAfterOtpVerify(page, params)`: chờ `login-continue-target`/`login-continue-retry` trong cửa sổ 30s; cả hai vắng mặt thì phân ba nhánh recovery (re-navigate hop `/login/continue` chết tầng mạng, re-click `login-code-submit` khi `login-request-failed` hiển thị, throw cho trạng thái mã không có recovery). Hợp đồng recovery đầy đủ, kèm bằng chứng run CI của từng nhánh, sống ở JSDoc của hàm này.
- **`MAX_VERIFY_ATTEMPTS`** — ngân sách lượt của vòng chờ (1 lượt verify đầu + 1 lượt recovery duy nhất); cạn ngân sách là lỗi thật.
- **`src/otp-verify-recovery.spec.ts`** — unit test các nhánh trên bằng locator giả theo kịch bản; `vi.mock('@playwright/test')` thay `expect` của Playwright để unit test không kéo Playwright runtime.
- **`src/index.ts`** — bề mặt public duy nhất của gói; consumer không import sâu vào module riêng lẻ.

## Boundaries

- Gói này không phải một suite thực thi được: không có target `system-test` — chỉ `lint`, `typecheck`, `test`, `build` (docs/architecture/06-testing.md §4).
- Không sở hữu bất kỳ state hay database nào và không đụng code app/deploy: helper chỉ điều khiển `Page`/`Locator` mà suite truyền vào, đọc test id theo contract của trang login account mà cả 4 consumer cùng dùng.
- Chỉ nhận thêm helper khi có ÍT NHẤT HAI consumer thật và consumer được nêu tên; logic single-consumer sống ở suite sở hữu nó (cùng ràng buộc với `libs/deployment`). Consumer hiện nay: `backoffice-access-control-e2e`, `cross-product-journey-e2e`, `pact-broker-portal-e2e`, `remote-cache-portal-e2e`.
- Suite không import gì từ support của suite khác — đường chia sẻ duy nhất là gói này; `pnpm dx arch-check` chặn tag và `@nx/enforce-module-boundaries` chặn hướng phụ thuộc (`type:tooling` chỉ phụ thuộc `type:tooling`).

## Development

- Gói export thẳng `src/index.ts` qua điều kiện `@ecoma-io/source` + `default` trong `exports` — vitest và Playwright chạy TS nguồn trực tiếp, không có artifact build nào được tiêu thụ; `build` chỉ phát declaration để typecheck project references.
- Import nội bộ dùng đuôi `.js` (tsconfig.lib `moduleResolution: nodenext`, cùng quy ước với `libs/deployment`).
- Sửa helper xong chạy đủ ba target của project trước khi commit:

```bash
pnpm nx run-many -t lint,typecheck,test -p system-tests-support
```

## Testing

Target canonical `test` (vitest) phủ logic nhánh của helper; hành vi end-to-end thật của pha chờ thuộc 4 suite e2e consumer chạy qua target `system-test` của từng suite (docs/architecture/06-testing.md §3–§4), không nhân bản ở đây.

```bash
pnpm nx run @ecoma-io/system-tests-support:test
```

- Unit test dùng locator giả theo kịch bản: mỗi lượt `waitFor` đọc tiếp một outcome ("visible"/"missing") từ queue, giúp assert đúng nhánh mà không chờ timeout thật.
- Các case: target mount lượt đầu; re-click `login-code-submit` đúng một lượt khi verify chết tầng mạng rồi thành công; chết lần hai throw và vòng cạn ở `MAX_VERIFY_ATTEMPTS`; trạng thái mã không recovery throw ngay; re-navigate hop `/login/continue` chết đúng một lượt và throw khi lần hai vẫn không có card; bấm `login-continue-retry` đúng một lượt.

## Related Documentation

- [`docs/architecture/06-testing.md`](../../docs/architecture/06-testing.md) — quy tắc support dùng chung của `system-tests/` (§2), taxonomy và canonical targets (§3–§4), dependency graph truthful (§5).
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) §7 — dependency rules theo tag mà gói này chịu: `type:tooling` chỉ phụ thuộc `type:tooling`, `scope:shared` là đáy trục ownership.
- [`libs/deployment/README.md`](../../libs/deployment/README.md) — ràng buộc "ít nhất hai consumer thật" mà gói áp dụng cùng một hình.
