# llm-upstream-mock

Mock upstream OpenAI-compatible **chỉ phục vụ testing** — mô phỏng đúng subset bề mặt upstream mà `llm-api` tiêu thụ: `POST /v1/chat/completions` (nhận diện stream/non-stream) và `GET /v1/models`, kèm ma trận lỗi inject được (Issue #132).

Không dùng ngoài testing, không nằm trong production topology, và **không phục vụ unit test** của project khác — chỉ tầng integration và system test (quyết định owner ghi tại Issue #132).

## Chạy

```bash
# Từ repo root, port mặc định 8787:
pnpm exec tsx tools/llm-upstream-mock/src/main.ts

# Ví dụ với config riêng:
MOCK_UPSTREAM_PORT=9091 MOCK_UPSTREAM_SCENARIO=rate_limited \
  pnpm exec tsx tools/llm-upstream-mock/src/main.ts
```

Server chỉ listen trên `127.0.0.1`. Dừng bằng SIGINT/SIGTERM (Ctrl-C).

## Config contract

Toàn bộ config qua biến môi trường, đều tùy chọn; sai giá trị fail-fast khi boot:

| Biến                       | Mặc định                        | Ý nghĩa                                                         |
| -------------------------- | ------------------------------- | --------------------------------------------------------------- |
| `MOCK_UPSTREAM_PORT`       | `8787`                          | Port listen (`0` = chọn port ephemeral)                         |
| `MOCK_UPSTREAM_SCENARIO`   | `ok`                            | Scenario mặc định cho mọi request                               |
| `MOCK_UPSTREAM_MODELS`     | `["mock-chat-model"]`           | Mảng JSON các model id trả ra cho `GET /v1/models` (không rỗng) |
| `MOCK_UPSTREAM_CONTENT`    | `Hello from llm-upstream-mock.` | Content của message assistant trong response thành công         |
| `MOCK_UPSTREAM_TIMEOUT_MS` | `30000`                         | Độ trễ trước khi destroy socket ở scenario `timeout`            |

**Override per-request:** header `x-mock-scenario: <tên scenario>` trên bất kỳ request nào ghi đè scenario mặc định cho đúng request đó — stateless, song song được trong test. Giá trị sai tên scenario → `400`, không âm thầm fallback.

## Ma trận scenario

| Scenario       | `POST /v1/chat/completions`                                                                                                              | `GET /v1/models`        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `ok`           | `200` JSON shape `chat.completion` (hoặc SSE minimal nếu `"stream": true`)                                                               | `200` shape list OpenAI |
| `unauthorized` | `401` — phong bì lỗi OpenAI, `code: invalid_api_key`                                                                                     | `401`                   |
| `rate_limited` | `429` — `code: rate_limit_exceeded`, header `retry-after: 1`                                                                             | `429`                   |
| `server_error` | `500` — `type: api_error`                                                                                                                | `500`                   |
| `timeout`      | Không phản hồi — socket giữ đến `MOCK_UPSTREAM_TIMEOUT_MS` rồi destroy                                                                   | `timeout`               |
| `malformed`    | `200` với JSON hợp lệ nhưng **vi phạm shape OpenAI** (thiếu `choices`/`usage` — input cho nhánh `usage_status = malformed` của consumer) | `200` malformed         |

Nhánh stream: body có `"stream": true` → `text/event-stream` với 3 chunk `chat.completion.chunk` (role → content → `finish_reason: stop`) rồi sentinel `data: [DONE]` — **đủ để client phân biệt stream thành công, không phải SSE fidelity đầy đủ** (non-goal, Issue #132, known limitation #28).

Các response cấu trúc không chịu scenario: route lạ → `404`, sai method → `405` + header `Allow`, body JSON hỏng → `400` — tất cả dùng chung phong bì lỗi OpenAI `{ "error": { "message", "type", "param", "code" } }`.

## Test

```bash
pnpm nx run llm-upstream-mock:test --skip-nx-cache
```

- `src/contract.spec.ts` — ghim **đúng tập key** của từng shape (completion, chunk, model list, error envelope) theo nguồn chân lý `docs/applications/llm-api/README.md` và `apps/llm-api/tests/integrations/http-contract.spec.ts` — hàng rào chống drift khỏi API thật.
- `src/server.spec.ts` — hành vi HTTP thật qua `fetch`: từng scenario, header override, control path, và fence "log không chứa prompt/response body".
- `src/config.spec.ts` — parse env: default, giá trị biên, fail-fast.

## Giới hạn đã biết

- Không auth thật: scenario `ok` không kiểm `Authorization` — `401` chỉ đến từ scenario `unauthorized`.
- Non-goal: embeddings, legacy completions, tool calls, SSE fidelity đầy đủ — chỉ dựng khi có consumer thật.
- Chỉ HTTP trên loopback; wiring container vào lane local là follow-up riêng (precedent SeaweedFS #117).
