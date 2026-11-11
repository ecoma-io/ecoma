# llm-api

Deploy unit `llm-api` — data plane LLM trên Cloudflare Workers, phục vụ dưới
`/llm`. Runtime là Rust (workers-rs) dịch ra WASM qua `worker-build`; slice
này (Issue #22) chỉ có nền tảng Worker runtime: `/health`, `/ready`,
`/v1/models` fail-closed — không business logic, không inference (Issue
#23/#24).

## Prerequisites

Toolchain được pin qua `rust-toolchain.toml` (1.98.1 + target
`wasm32-unknown-unknown`); rustup tự override theo thư mục project, nhưng hai
bước dưới vẫn phải chạy trước khi build lần đầu:

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
```

## Nx targets

| Target       | Command                  | Ý nghĩa                                                                                   |
| ------------ | ------------------------ | ----------------------------------------------------------------------------------------- |
| `build`      | `worker-build --release` | Sinh bundle Worker tại `build/index.js` (entry của wrangler)                              |
| `test`       | `cargo test`             | Unit test colocated chạy trên host toolchain                                              |
| `lint`       | oxlint + fmt + clippy    | `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `npx oxlint .` |
| `typecheck`  | `tsc --build`            | Chỉ phần TS (`db/`, `tests/`) — runtime Worker là Rust                                    |
| `db:migrate` | `db/apply.mts`           | Migration runner — chạy ở CI runner, KHÔNG qua Hyperdrive                                 |

Ví dụ:

```sh
npx nx run @ecoma-io/llm-api:build
npx nx run @ecoma-io/llm-api:test
npx nx run @ecoma-io/llm-api:lint
```

## HTTP contract (đóng băng)

| Route            | Trạng thái | Điều kiện                                                              |
| ---------------- | ---------- | ---------------------------------------------------------------------- |
| `GET /health`    | 200        | Luôn — liveness, không chạm database                                   |
| `GET /ready`     | 200 / 503  | 200 khi cả ba Hyperdrive binding `SELECT 1` thành công; ngược lại 503  |
| `GET /v1/models` | 200 / 503  | 200 với body `{"object":"list","data":[]}` khi DB ready; ngược lại 503 |
| Route khác       | 404        | —                                                                      |

Fail-closed là bất biến: một binding thiếu, lỗi kết nối hay timeout (3s per
binding) đều đẩy `/ready` và `/v1/models` về 503.

## Hyperdrive bindings

Ba binding khai báo trong `wrangler.jsonc` với pattern id chuỗi rỗng (chưa
provision): `DB_LLM_GATEWAY`, `DB_LLM_TENANT`, `DB_LLM_MARKETPLACE`.

Khi chạy `wrangler dev` local, mỗi binding cần connection string PostgreSQL
của riêng nó qua biến môi trường:

```sh
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_LLM_GATEWAY
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_LLM_TENANT
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_LLM_MARKETPLACE
```

Thiếu biến nào lúc `wrangler dev` là lỗi boot tường minh (fail-closed) —
worker không chạy với binding nửa vời. Các biến này KHÔNG bao giờ được commit.

Khi provision thật: query cache của Hyperdrive PHẢI OFF (cache không
invalidate khi ghi — dữ liệu quota/settlement), và migration KHÔNG chạy qua
binding (Hyperdrive không hỗ trợ advisory lock) — chạy từ CI runner bằng
credential migrator.

Local port khi `wrangler dev`: `4211` (khai báo trong `wrangler.jsonc`).
