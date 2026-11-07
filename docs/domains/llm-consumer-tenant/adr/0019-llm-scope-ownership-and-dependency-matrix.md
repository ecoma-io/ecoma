# ADR-0019 — Ba scope ownership cho LLM domain library và dependency matrix của chúng

**Trạng thái:** Accepted · **Ngày:** 2026-11-06 · **Issue:** #559

> ADR này kiêm luôn quyết định cho `llm-consumer-tenant` về việc tách scope: nó áp cho toàn bộ LLM domain library, không riêng Consumer. Đặt tại đây vì `docs/AGENTS.md` §10 không cho phép một ADR directory toàn cục; `docs/architecture/05-code-architecture.md` §6.3 trỏ về ADR này.

## Bối cảnh

Mọi LLM domain library đang dùng chung tag `scope:llm`. `scope` là trục ownership, và `.oxlintrc.json` chỉ cho `scope:llm` phụ thuộc `scope:llm`, nên **mọi** LLM domain library import được **mọi** LLM domain library khác. Không constraint nào trong repo ngăn được:

- một Consumer domain library import một Seller domain library;
- Marketplace import trực tiếp Governance implementation thay vì tiêu thụ verdict;
- Financial import Seller domain library.

## Quyết định

`scope:llm` được thay bằng ba giá trị, mỗi project đúng một giá trị:

| Scope          | Project                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `llm-consumer` | `llm-consumer-tenant-domain`, `llm-consumer-routing-domain`                                                       |
| `llm-seller`   | `llm-seller-tenant-domain`, `llm-seller-governance-domain`, `llm-marketplace-domain`, `llm-seller-pricing-domain` |
| `llm-shared`   | `llm-inference-domain`, `llm-usage-domain`, `llm-financial-domain`                                                |

Ba bất biến enforce bằng tag trong `.oxlintrc.json`:

1. `scope:llm-consumer` không phụ thuộc `scope:llm-seller`, kể cả transitively.
2. `scope:llm-seller` không phụ thuộc `scope:llm-consumer`, kể cả transitively.
3. `scope:llm-shared` không phụ thuộc `scope:llm-consumer` hoặc `scope:llm-seller`.

Cả ba scope vẫn được phụ thuộc `scope:shared`, `scope:platform` và `type:contracts`.

### Ranh giới nội bộ trong một scope

Tag chỉ encode ownership, không encode từng bounded context. Quan hệ **giữa các context trong cùng scope** — ví dụ `llm-marketplace-domain` không import `llm-seller-governance-domain` — được kiểm bằng một dependency matrix tường minh chạy trong `pnpm dx arch-check`, không bằng tag. Matrix liệt kê cặp project được phép có edge và fail-closed với mọi edge ngoài danh sách.

### Không giữ alias

`scope:llm` bị xoá khỏi `KNOWN_SCOPES` và `.oxlintrc.json`. Không giữ alias: không có consumer nào cần `scope:llm`, nên một alias chỉ làm constraint thứ ba có thể bị lách.

## Hệ quả

- Thêm scope mới phải cập nhật đồng thời `.oxlintrc.json` và `KNOWN_SCOPES` trong `tools/dx/src/architecture/arch-tags.ts`; `arch-tags.spec.ts` kiểm hai nguồn bằng cùng một fixture.
- `docs/architecture/05-code-architecture.md` §6.3 liệt kê ba scope mới thay cho `llm`.
