// Deploy unit `llm-api` — data plane LLM trên Cloudflare Workers, runtime Rust
// dịch ra WASM qua `worker-build` (Nx target `build` sinh `build/index.js`).
//
// Hợp đồng HTTP của slice Worker runtime (Issue #22, review PR #113) — hợp
// đồng body `/v1/models` ĐÃ được Issue #23 thay (supersession): body giờ là
// catalogue model thật đọc từ marketplace/gateway, không còn danh sách rỗng
// đóng băng; các quy tắc còn lại giữ nguyên:
// - `GET /health` → 200 liveness, KHÔNG chạm database.
// - `GET /ready` → 200 khi cả ba Hyperdrive binding `SELECT 1` thành công;
//   503 fail-closed khi một binding thiếu/lỗi/timeout.
// - `GET /v1/models` → 200 `application/json` với catalogue model `active`
//   (Issue #23); 503 fail-closed khi DB chưa ready, catalogue lỗi, hoặc một
//   offer active không ánh xạ được owner của nó.
// - `GET /llm/v1/models` → 200 với chính hợp đồng như `/v1/models`: base path
//   `/llm` là public contract (docs/architecture/01, bảng domain; A13 ranh
//   giới routing), production giữ nguyên tiền tố khi forward vào Worker.
// - Route khác → 404, bất kể method.
//
// Quyết định method (review PR #113): hợp đồng là GET-only. Method không phải
// GET trên một path đã định nghĩa (`/health`, `/ready`, `/v1/models`,
// `/llm/v1/models`) → 405 kèm header `Allow: GET` — không bao giờ biến thành
// response thành công. HEAD cũng nhận 405 vì hợp đồng chỉ định nghĩa GET.
// Path lạ → 404 bất kể method. Không thêm route `/llm/*` khác: `/health` và
// `/ready` là deployment-internal, probe trên đường mạng container, không qua
// domain công khai, nên `/llm/health` và `/llm/ready` vẫn 404.
//
// Bất biến platform: KHÔNG BAO GIỜ log prompt/response body, connection string
// hay credential. Log chỉ cấu trúc tối thiểu, chuỗi runtime tiếng Anh.

mod models;
mod readiness;

use worker::{console_log, event, Context, Env, Method, Request, Response, Result};

#[event(fetch)]
async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.url()?.path().to_string();
    let method = req.method();
    match (path.as_str(), method) {
        ("/health", Method::Get) => health(),
        ("/ready", Method::Get) => ready(&env).await,
        // Public path `/llm/v1/models` dùng cùng handler với `/v1/models`.
        ("/v1/models", Method::Get) | ("/llm/v1/models", Method::Get) => models(&env).await,
        // Path hợp lệ nhưng method không phải GET → 405 Allow: GET.
        ("/health" | "/ready" | "/v1/models" | "/llm/v1/models", _) => method_not_allowed(),
        _ => not_found(),
    }
}

// Liveness thuần: không probe database — route này phải trả lời cả khi mọi
// binding xuống, để orchestrator phân biệt được "process sống" với "phụ thuộc
// sẵn sàng".
fn health() -> Result<Response> {
    Response::ok("ok")
}

// Readiness fail-closed: chỉ 200 khi cả ba binding đều Ready (chi tiết probe
// và timeout per-binding nằm ở `readiness`).
async fn ready(env: &Env) -> Result<Response> {
    let report = readiness::readiness_all(env).await;
    if report.is_ready() {
        console_log!("[llm-api] /ready ok");
        Response::ok("ready")
    } else {
        let failures = report
            .failures()
            .iter()
            .map(|(binding, status)| format!("{}={}", binding, status.label()))
            .collect::<Vec<_>>()
            .join(",");
        console_log!("[llm-api] /ready not ready: {}", failures);
        Response::error("not ready", 503)
    }
}

// `/v1/models` cùng điều kiện readiness với `/ready`, rồi đọc catalogue thật
// (Issue #23): offer `active` từ marketplace, owner là tên tenant từ gateway.
// Fail-closed: DB chưa ready, catalogue lỗi hay owner không ánh xạ được đều
// là 503 — không bao giờ trả danh sách rỗng giả tạo hay model mù chủ sở hữu.
// Dựng response bằng builder thay vì `Response::ok`: `Response::ok` ghim
// cứng `Content-Type: text/plain; charset=utf-8` (response.rs worker 0.8.7),
// còn hợp đồng của endpoint này là `application/json` (review PR #113,
// finding A2). `fixed` trả `Response` thuần nên bọc `Ok`.
async fn models(env: &Env) -> Result<Response> {
    let report = readiness::readiness_all(env).await;
    if !report.is_ready() {
        console_log!("[llm-api] /v1/models not ready: db bindings failing");
        return Response::error("service unavailable", 503);
    }
    match models::serving_models(env).await {
        Ok(catalogue) => {
            console_log!("[llm-api] /v1/models ok: {} model(s)", catalogue.len());
            let body = models::models_list_body(&catalogue);
            Ok(Response::builder()
                .with_header("content-type", "application/json")?
                .fixed(body.as_bytes().to_vec()))
        }
        Err(_) => {
            console_log!("[llm-api] /v1/models catalogue failed");
            Response::error("service unavailable", 503)
        }
    }
}

fn not_found() -> Result<Response> {
    Response::error("not found", 404)
}

// 405 cho method không phải GET trên path đã định nghĩa — `Allow: GET` khai
// đúng method duy nhất hợp đồng chấp nhận (review PR #113). `fixed` trả
// `Response` thuần nên bọc `Ok`.
fn method_not_allowed() -> Result<Response> {
    Ok(Response::builder()
        .with_status(405)
        .with_header("allow", "GET")?
        .fixed(b"method not allowed".to_vec()))
}
