// Deploy unit `llm-api` — data plane LLM trên Cloudflare Workers, runtime Rust
// dịch ra WASM qua `worker-build` (Nx target `build` sinh `build/index.js`).
//
// Hợp đồng HTTP đóng băng của slice Worker runtime (Issue #22):
// - `GET /health` → 200 liveness, KHÔNG chạm database.
// - `GET /ready` → 200 khi cả ba Hyperdrive binding `SELECT 1` thành công;
//   503 fail-closed khi một binding thiếu/lỗi/timeout.
// - `GET /v1/models` → 200 với body chính xác `{"object":"list","data":[]}`
//   khi DB ready; 503 fail-closed khi không.
// - Route khác → 404. Không business logic, không inference (Issue #23/#24).
//
// Bất biến platform: KHÔNG BAO GIỜ log prompt/response body, connection string
// hay credential. Log chỉ cấu trúc tối thiểu, chuỗi runtime tiếng Anh.

mod readiness;

use worker::{console_log, event, Context, Env, Request, Response, Result};

// Body JSON đóng băng của `/v1/models` (Issue #22): danh sách model rỗng cho
// tới khi lane inference (Issue #24) bổ sung catalogue.
const MODELS_LIST_BODY: &str = r#"{"object":"list","data":[]}"#;

#[event(fetch)]
async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.url()?.path().to_string();
    match path.as_str() {
        "/health" => health(),
        "/ready" => ready(&env).await,
        "/v1/models" => models(&env).await,
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

// `/v1/models` cùng điều kiện readiness với `/ready`: catalogue model đọc từ
// DB, nên DB chưa sẵn sàng thì trả 503 thay vì danh sách rỗng giả tạo.
async fn models(env: &Env) -> Result<Response> {
    let report = readiness::readiness_all(env).await;
    if report.is_ready() {
        console_log!("[llm-api] /v1/models ok");
        Response::ok(MODELS_LIST_BODY)
    } else {
        console_log!("[llm-api] /v1/models not ready: db bindings failing");
        Response::error("service unavailable", 503)
    }
}

fn not_found() -> Result<Response> {
    Response::error("not found", 404)
}
