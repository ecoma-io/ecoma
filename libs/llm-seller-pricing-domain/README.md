# LLM Seller Pricing Domain

Thư viện domain thuần của bounded context `llm-seller-pricing` (`@ecoma-io/llm-seller-pricing-domain`): seller-configured customer price, pricing schedule theo offer, per-request/per-token pricing, peak/off-peak theo IANA timezone, versioning và pricing snapshot bất biến. Ngữ nghĩa, công thức và bất biến là nội dung canonical của [`docs/domains/llm-seller-pricing/`](../../docs/domains/llm-seller-pricing/README.md) — thư viện hiện thực một phần tri thức đó bằng code.

Nx project `@ecoma-io/llm-seller-pricing-domain`, tags `type:domain`, `scope:llm-seller`, `runtime:universal`; `package.json` không có dependency nào.

## Purpose

- Cung cấp value object và phép tính giá thuần cho context: từ price set, schedule, version cho tới snapshot và kết quả tính giá.
- Giữ seller-configured price là customer price: provider cost không phải input của thư viện và không được dùng để suy giá (OB-7 trong [`open-boundaries.md`](../../docs/domains/open-boundaries.md)).

## Responsibilities

- **Điểm cố định** (`fixed-point.ts`, `currency.ts`, `instant.ts`): `isFixedPointAmount`, `isPriceScale`, `isAmountScale`, `AMOUNT_SCALE_MAX`, `PRICE_SCALE_MAX`, `ROUNDING_RULES`, `isCurrencyCode`, `isEpochMillis`.
- **Price set** (`price.ts`): `readPriceSet`, `resolvePriceSet`, subset rule (`readSubsetPriceRule`) — cached tokens là subset của input, reasoning tokens là subset của output.
- **Peak window** (`peak-window.ts`): `isIanaTimeZone`, `isPeakWindow`, `isWithinPeakWindow`.
- **Schedule và version** (`pricing-schedule.ts`, `pricing-version.ts`): `readPricingSchedule`, `appendPricingVersion`, `readPricingVersionHistory`, `selectApplicableVersion`.
- **Token usage** (`token-usage.ts`): `isTokenUsage`, `readRequestCount`, `readTokenUsage`.
- **Tính giá** (`calculate-price.ts`): `calculatePrice` trả `PriceCalculation`/`PricedAmount`.
- **Snapshot** (`pricing-snapshot.ts`): `createPricingSnapshot`, `resolvePricingSnapshot`, `calculateSnapshotPrice`, `PRICING_PERIODS`.
- **Lỗi và result** (`errors.ts`, `result.ts`): `PricingResult` (`pricingOk`/`pricingFailure`), `LLM_PRICING_DOMAIN_ERROR_MESSAGES`.

## Boundaries

- Thuần TypeScript: không import Nx project khác, không SQL, không Node builtin, không I/O, không đọc đồng hồ — mọi mốc thời gian do caller truyền vào.
- Chỉ định giá: không reserve quota, không dispatch, không settle usage, không charge wallet, không giữ balance — pricing và settlement là hai responsibility khác nhau của hệ thống ([`docs/domains/llm-seller-pricing/README.md`](../../docs/domains/llm-seller-pricing/README.md) §Boundary).
- Không có tier pricing (graduated/volume/threshold/window) và không chuyển đổi currency: một snapshot mang đúng một currency và một cặp scale; pricing dimension chỉ có per-request và per-token.
- Schedule được key theo **offer** — pricing granularity giữa offer và normalized model là quyết định chưa chốt trong [domain model](../../docs/domains/llm-seller-pricing/domain-model.md), thư viện không tự mở rộng.

## Development

```bash
pnpm nx run @ecoma-io/llm-seller-pricing-domain:lint
pnpm nx run @ecoma-io/llm-seller-pricing-domain:typecheck   # tsc --build --emitDeclarationOnly
```

Entry công khai duy nhất là `src/index.ts` (`main` của package); thêm module mới đi kèm spec colocated và export tường minh qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/llm-seller-pricing-domain:test        # vitest — spec colocated trong src/
```

Spec colocated cạnh subject, ví dụ `price.spec.ts`, `calculate-price.spec.ts`, `pricing-snapshot.spec.ts`.

## Related Documentation

- [`docs/domains/llm-seller-pricing/README.md`](../../docs/domains/llm-seller-pricing/README.md) — bounded context `llm-seller-pricing` và ranh giới pricing.
- [`docs/domains/llm-seller-pricing/domain-model.md`](../../docs/domains/llm-seller-pricing/domain-model.md) — công thức, bất biến, error taxonomy, quyết định chưa chốt.
- [`docs/domains/open-boundaries.md`](../../docs/domains/open-boundaries.md) — ranh giới nghiệp vụ chưa chốt, gồm provider cost ownership (OB-7).
- [`docs/applications/llm-api/README.md`](../../docs/applications/llm-api/README.md) — application host context này theo catalog Applications.
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — ba scope ownership của LLM domain library và dependency rule (§6, §7).
