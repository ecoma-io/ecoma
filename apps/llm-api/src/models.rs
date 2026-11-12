//! Catalogue model của `/v1/models` (Issue #23): đọc ModelOffer `active` từ
//! binding marketplace, ánh xạ `seller_tenant_id` → tên tenant công khai từ
//! binding gateway, trả về đúng hợp đồng OpenAI-compatible
//! `{"object":"list","data":[{"id","object":"model","created","owned_by"}]}`.
//!
//! Quy tắc fail-closed (ADR-0027 §7, domain-model llm-marketplace §8):
//! - Chỉ offer `active` được liệt kê; offer `draft` chưa từng được probe khỏe
//!   và chưa có verdict eligible nên không bao giờ xuất hiện.
//! - Offer `active` mà `seller_tenant_id` không ánh xạ được sang tenant ở
//!   gateway ⇒ lỗi catalogue ⇒ route trả 503 (không liệt kê "mù" một model
//!   với owner không xác thực được).
//! - Lỗi query trên một trong hai binding ⇒ 503, không fallback danh sách rỗng
//!   giả tạo.
//!
//! Bất biến platform: KHÔNG BAO GIỜ log connection string, credential hay
//! body. Log chỉ cấu trúc tối thiểu.

use tokio_postgres::SimpleQueryMessage;
use worker::{Env, Hyperdrive};

use crate::readiness::{binding_simple_query, BINDING_GATEWAY, BINDING_MARKETPLACE};

/// Một model đang phục vụ trong catalogue công khai.
pub(crate) struct ServingModel {
    /// Normalized model id — định danh công khai trên `/v1/models`.
    pub(crate) id: String,
    /// Thời điểm offer được tạo, quy đổi ra giây epoch (quy ước OpenAI).
    pub(crate) created: i64,
    /// Tên Seller tenant sở hữu offer — định danh công khai của owner.
    pub(crate) owned_by: String,
}

/// Đọc toàn bộ message của một câu lệnh qua binding; lỗi nội bộ không log
/// chi tiết (tránh lộ connection string/credential qua thông báo lỗi).
async fn query_binding(
    hyperdrive: Hyperdrive,
    sql: &'static str,
) -> Result<Vec<SimpleQueryMessage>, ()> {
    binding_simple_query(hyperdrive, sql).await.map_err(|_| ())
}

/// Lấy Hyperdrive binding theo tên; binding thiếu là lỗi catalogue.
fn env_binding(env: &Env, name: &'static str) -> Result<Hyperdrive, ()> {
    env.hyperdrive(name).map_err(|_| ())
}

/// Trích giá trị cột dạng text từ một row của `simple_query`.
fn row_text<'a>(row: &'a tokio_postgres::SimpleQueryRow, column: &str) -> Result<&'a str, ()> {
    row.get(column).ok_or(())
}

/// Đọc các offer `active`: `(normalized model id công khai, created_at millis, seller_tenant_id)`.
async fn fetch_active_offers(env: &Env) -> Result<Vec<(String, i64, String)>, ()> {
    let hyperdrive = env_binding(env, BINDING_MARKETPLACE)?;
    let messages = query_binding(
        hyperdrive,
        "SELECT normalized_model_id, created_at, seller_tenant_id FROM llm_marketplace.model_offers WHERE status = 'active' ORDER BY created_at, normalized_model_id",
    )
    .await?;
    let mut offers = Vec::new();
    for message in messages {
        let tokio_postgres::SimpleQueryMessage::Row(row) = message else {
            continue;
        };
        let id = row_text(&row, "normalized_model_id")?.to_string();
        let created_at: i64 = row_text(&row, "created_at")?.parse().map_err(|_| ())?;
        let seller_tenant_id = row_text(&row, "seller_tenant_id")?.to_string();
        offers.push((id, created_at, seller_tenant_id));
    }
    Ok(offers)
}

/// Đọc ánh xạ `tenant id → tên tenant công khai` từ gateway.
async fn fetch_tenant_names(env: &Env) -> Result<Vec<(String, String)>, ()> {
    let hyperdrive = env_binding(env, BINDING_GATEWAY)?;
    let messages =
        query_binding(hyperdrive, "SELECT id, name FROM llm_seller.seller_tenants").await?;
    let mut tenants = Vec::new();
    for message in messages {
        let tokio_postgres::SimpleQueryMessage::Row(row) = message else {
            continue;
        };
        let id = row_text(&row, "id")?.to_string();
        let name = row_text(&row, "name")?.to_string();
        tenants.push((id, name));
    }
    Ok(tenants)
}

/// Escape một chuỗi thành JSON string literal (không bao gồm dấu ngoặc kép
/// bao ngoài). Đủ cho catalogue: escape `"` `\` và control characters.
fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            control if control.is_control() => {
                escaped.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => escaped.push(other),
        }
    }
    escaped
}

/// Dựng body JSON của `/v1/models` — hàm thuần để unit test.
pub(crate) fn models_list_body(models: &[ServingModel]) -> String {
    let items = models
        .iter()
        .map(|model| {
            format!(
                "{{\"id\":\"{}\",\"object\":\"model\",\"created\":{},\"owned_by\":\"{}\"}}",
                json_escape(&model.id),
                model.created,
                json_escape(&model.owned_by)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"object\":\"list\",\"data\":[{items}]}}")
}

/// Lấy catalogue model đang phục vụ: offer `active` từ marketplace, owner
/// ánh xạ qua tenant gateway. Bất kỳ lỗi nào (binding thiếu, query lỗi, tenant
/// không ánh xạ được) đều là lỗi catalogue — route quyết định fail-closed.
pub(crate) async fn serving_models(env: &Env) -> Result<Vec<ServingModel>, ()> {
    let offers = fetch_active_offers(env).await?;
    if offers.is_empty() {
        return Ok(Vec::new());
    }
    let tenants = fetch_tenant_names(env).await?;
    let mut models = Vec::with_capacity(offers.len());
    for (id, created_at_millis, seller_tenant_id) in offers {
        let owned_by = tenants
            .iter()
            .find(|(tenant_id, _)| tenant_id == &seller_tenant_id)
            .map(|(_, name)| name.clone())
            .ok_or(())?;
        models.push(ServingModel {
            id,
            created: created_at_millis / 1000,
            owned_by,
        });
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, created: i64, owned_by: &str) -> ServingModel {
        ServingModel {
            id: id.to_string(),
            created,
            owned_by: owned_by.to_string(),
        }
    }

    #[test]
    fn empty_catalogue_keeps_the_frozen_empty_list_body() {
        assert_eq!(models_list_body(&[]), r#"{"object":"list","data":[]}"#);
    }

    #[test]
    fn one_model_renders_the_openai_compatible_shape() {
        let body = models_list_body(&[model("dronie-flash", 1_760_000_000, "dronie")]);
        assert_eq!(
            body,
            r#"{"object":"list","data":[{"id":"dronie-flash","object":"model","created":1760000000,"owned_by":"dronie"}]}"#
        );
    }

    #[test]
    fn models_render_in_given_order_without_separating_comma_issues() {
        let body = models_list_body(&[
            model("model-a", 1, "tenant-a"),
            model("model-b", 2, "tenant-b"),
        ]);
        assert_eq!(
            body,
            r#"{"object":"list","data":[{"id":"model-a","object":"model","created":1,"owned_by":"tenant-a"},{"id":"model-b","object":"model","created":2,"owned_by":"tenant-b"}]}"#
        );
    }

    #[test]
    fn json_escape_neutralizes_quotes_and_backslashes() {
        assert_eq!(json_escape("a\"b\\c"), "a\\\"b\\\\c");
    }
}
