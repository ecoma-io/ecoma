# LLM Upstream Mock

Mock upstream OpenAI-compatible **chỉ phục vụ testing** (`@ecoma-io/llm-upstream-mock`): mô phỏng đúng subset bề mặt upstream mà `llm-api` tiêu thụ — `POST /v1/chat/completions` (stream/non-stream) và `GET /v1/models` — kèm ma trận lỗi inject được qua env hoặc header per-request. Server Node thuần (`node:http`), listen `127.0.0.1` (`src/main.ts:16`), không dependency runtime nào trong `package.json`.

Nx project `@ecoma-io/llm-upstream-mock`, tags `type:tooling`, `runtime:native`, `scope:local`.

## Purpose

- Cấp upstream giả có hành vi lỗi thật (`401`/`429`/`500`/timeout/malformed) cho tầng integration và system test của `llm-api` và `deploys/llm-api-deploy`, thay vì gọi upstream thật trong test.
- Ghim contract phản hồi theo nguồn chân lý `docs/applications/llm-api/README.md` và `apps/llm-api/tests/integrations/http-contract.spec.ts` — khi API thật đổi shape, spec của mock fail trước (`src/contract.spec.ts`).

## Responsibilities

- Hai route: `POST /v1/chat/completions` (nhận diện `"stream": true` → SSE 3 chunk `chat.completion.chunk` + sentinel `data: [DONE]`; non-stream → JSON `chat.completion`) và `GET /v1/models` (`src/server.ts`).
- Sáu scenario (`SCENARIOS` trong `src/config.ts:11`): `ok`, `unauthorized` (401 `invalid_api_key`), `rate_limited` (429 + `retry-after: 1`), `server_error` (500 `api_error`), `timeout` (giữ socket đến `MOCK_UPSTREAM_TIMEOUT_MS` rồi destroy), `malformed` (200 nhưng thiếu `choices`/`usage`).
- Scenario mặc định qua env `MOCK_UPSTREAM_SCENARIO`; override per-request bằng header `x-mock-scenario` (`SCENARIO_HEADER`) — sai tên scenario → `400`, không fallback âm thầm.
- Config toàn env, tùy chọn, fail-fast khi boot (`src/config.ts`): `MOCK_UPSTREAM_PORT` (mặc định 8787, `0` = ephemeral), `MOCK_UPSTREAM_MODELS`, `MOCK_UPSTREAM_CONTENT`, `MOCK_UPSTREAM_TIMEOUT_MS`, `MOCK_UPSTREAM_EXPECTED_AUTHORIZATION` (tắt mặc định — bật kiểm `Authorization` đúng giá trị: chuỗi đơn hoặc mảng JSON cho rotation; sai/thiếu → `401 invalid_api_key`).
- Response cấu trúc không chịu scenario: route lạ → `404`, sai method → `405` + header `Allow`, body JSON hỏng → `400` — dùng chung phong bì lỗi OpenAI.

## Boundaries

- Không dùng ngoài testing: không nằm trong production topology, không auth thật (401 chỉ đến từ scenario `unauthorized`, hoặc từ gate `MOCK_UPSTREAM_EXPECTED_AUTHORIZATION` khi bật — opt-in test-only, so sánh timing-safe; log chỉ ghi verdict một-bit `auth=ok|rejected`, không bao giờ giá trị header).
- Không phải SSE fidelity đầy đủ: nhánh stream chỉ đủ để client phân biệt stream thành công — embeddings, legacy completions, tool calls không có trong surface.
- Không wiring container vào lane local platform; mock chạy bằng process `tsx` trên host.
- Non-goal phát sinh surface mới khi chưa có consumer thật — quyết định phạm vi owner ghi tại Issue #132.

## Development

```bash
pnpm exec tsx tools/llm-upstream-mock/src/main.ts                 # chạy server, port mặc định 8787
MOCK_UPSTREAM_SCENARIO=rate_limited pnpm exec tsx tools/llm-upstream-mock/src/main.ts
pnpm nx run @ecoma-io/llm-upstream-mock:lint
pnpm nx run @ecoma-io/llm-upstream-mock:typecheck
```

Dừng bằng SIGINT/SIGTERM; server chỉ listen loopback.

## Testing

```bash
pnpm nx run @ecoma-io/llm-upstream-mock:test
```

Spec colocated trong `src/`: `contract.spec.ts` ghim tập key của từng shape (completion, chunk, model list, error envelope); `server.spec.ts` chạy hành vi HTTP thật qua `fetch` cho từng scenario, header override, control path, gate `MOCK_UPSTREAM_EXPECTED_AUTHORIZATION` (401 + fence verdict `auth=ok|rejected`) và fence "log không chứa prompt/response body"; `config.spec.ts` phủ parse env, giá trị biên, fail-fast.

## Related Documentation

- [`docs/applications/llm-api/README.md`](../../docs/applications/llm-api/README.md) — nguồn chân lý contract HTTP mà mock ghim.
- [`apps/llm-api/README.md`](../../apps/llm-api/README.md) — consumer chính và bề mặt upstream thật.
- [`deploys/llm-api-deploy/README.md`](../../deploys/llm-api-deploy/README.md) — deploy unit tiêu thụ mock trên lane local.
- [`docs/architecture/06-testing.md`](../../docs/architecture/06-testing.md) — phân loại tầng test và target canonical.
