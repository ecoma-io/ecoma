//! Kiểm tra sẵn sàng của ba Hyperdrive binding của deploy unit `llm-api`.
//!
//! Hợp đồng HTTP đóng băng (Issue #22): `/ready` và `/v1/models` fail-closed —
//! chỉ trả 200 khi cả ba binding kết nối được và `SELECT 1` thành công trên cả
//! ba database; một binding thiếu/kết nối lỗi/timeout đều là 503. Mỗi binding
//! có timeout riêng ngắn nên route không bao giờ treo chờ database chết.
//!
//! Bất biến platform: KHÔNG BAO GIỜ log connection string, credential hay
//! body. Log chỉ cấu trúc tối thiểu (route, outcome, tên binding lỗi).

use std::pin::pin;
use std::time::Duration;

use futures_util::future::{join3, select, Either};
use tokio_postgres::SimpleQueryMessage;
use worker::{postgres_tls::PassthroughTls, Delay, Env, Hyperdrive, SecureTransport, Socket};

// Timeout per-binding của probe readiness. Đủ ngắn để `/ready` không treo,
// đủ dài cho connection thật qua Hyperdrive local emulation.
const BINDING_TIMEOUT: Duration = Duration::from_secs(3);

// Tên binding khớp chính xác `wrangler.jsonc` — đổi một phía là phải đổi cả
// hai phía cùng lúc (hợp đồng đóng băng của Issue #22).
pub(crate) const BINDING_GATEWAY: &str = "DB_LLM_GATEWAY";
pub(crate) const BINDING_TENANT: &str = "DB_LLM_TENANT";
pub(crate) const BINDING_MARKETPLACE: &str = "DB_LLM_MARKETPLACE";

/// Kết quả probe một binding. Nhãn là chuỗi runtime tiếng Anh (chỉ dùng cho
/// log cấu trúc tối thiểu).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BindingStatus {
    Ready,
    Unavailable,
    Missing,
    TimedOut,
}

impl BindingStatus {
    pub(crate) fn label(self) -> &'static str {
        match self {
            BindingStatus::Ready => "ready",
            BindingStatus::Unavailable => "unavailable",
            BindingStatus::Missing => "missing",
            BindingStatus::TimedOut => "timeout",
        }
    }
}

/// Bảng trạng thái của cả ba binding sau một vòng probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ReadinessReport {
    pub(crate) gateway: BindingStatus,
    pub(crate) tenant: BindingStatus,
    pub(crate) marketplace: BindingStatus,
}

impl ReadinessReport {
    /// Fail-closed: chỉ sẵn sàng khi cả ba binding đều Ready — một binding
    /// xuống là toàn bộ data plane coi như chưa sẵn sàng.
    pub(crate) fn is_ready(&self) -> bool {
        self.gateway == BindingStatus::Ready
            && self.tenant == BindingStatus::Ready
            && self.marketplace == BindingStatus::Ready
    }

    /// Các binding chưa Ready, theo đúng thứ tự khai báo — dùng cho log.
    pub(crate) fn failures(&self) -> Vec<(&'static str, BindingStatus)> {
        let mut failed = Vec::new();
        if self.gateway != BindingStatus::Ready {
            failed.push((BINDING_GATEWAY, self.gateway));
        }
        if self.tenant != BindingStatus::Ready {
            failed.push((BINDING_TENANT, self.tenant));
        }
        if self.marketplace != BindingStatus::Ready {
            failed.push((BINDING_MARKETPLACE, self.marketplace));
        }
        failed
    }
}

/// Probe song song cả ba binding, mỗi probe có timeout riêng.
pub(crate) async fn readiness_all(env: &Env) -> ReadinessReport {
    // Mỗi future probe giữ Socket/Connection qua các điểm await nên không
    // Unpin — ghim stack trước khi `join3`; `Pin<&mut _>` tự Unpin.
    let mut gateway = pin!(probe_env_binding(env, BINDING_GATEWAY));
    let mut tenant = pin!(probe_env_binding(env, BINDING_TENANT));
    let mut marketplace = pin!(probe_env_binding(env, BINDING_MARKETPLACE));
    let (gateway, tenant, marketplace) =
        join3(gateway.as_mut(), tenant.as_mut(), marketplace.as_mut()).await;
    ReadinessReport {
        gateway,
        tenant,
        marketplace,
    }
}

/// Lỗi bên trong một vòng probe — chỉ dùng nội bộ để gộp về
/// `BindingStatus::Unavailable`; chi tiết lỗi không bao giờ đi vào log (tránh
/// lộ connection string/credential qua thông báo lỗi).
#[derive(Debug)]
pub(crate) enum ProbeError {
    // Lỗi khi mở Socket tới Hyperdrive.
    Socket,
    // Connection string của binding không parse được thành config.
    Config,
    // Connection/auth tới database thất bại hoặc ngắt trước khi có câu trả lời.
    Connect,
    // `SELECT 1` bị từ chối.
    Query,
    // Câu lệnh chạy nhưng không có dòng trả lời.
    NoRow,
}

async fn probe_env_binding(env: &Env, name: &'static str) -> BindingStatus {
    // Binding thiếu trong env (vd deploy thiếu binding thật) là Missing —
    // fail-closed, không bao giờ suy đoán.
    let hyperdrive = match env.hyperdrive(name) {
        Ok(hyperdrive) => hyperdrive,
        Err(_) => return BindingStatus::Missing,
    };
    let mut probe = pin!(probe_binding(hyperdrive));
    let timer = Delay::from(BINDING_TIMEOUT);
    match select(probe.as_mut(), timer).await {
        Either::Left((result, _)) => match result {
            Ok(()) => BindingStatus::Ready,
            Err(_) => BindingStatus::Unavailable,
        },
        Either::Right((_, _)) => BindingStatus::TimedOut,
    }
}

/// Chạy một `simple_query` qua Hyperdrive binding, tái dùng đúng pattern đã
/// được thí nghiệm xác nhận (Issue #22, criteria 3): Socket với StartTls,
/// `connect_raw` với PassthroughTls, race query-vs-connection với timeout bọc
/// ngoài ở caller. Trả về toàn bộ message (có thể rỗng — caller tự quyết định
/// rỗng có hợp lệ hay không). Dùng chung cho probe readiness và catalogue
/// model (Issue #23); chi tiết lỗi không bao giờ đi vào log.
pub(crate) async fn binding_simple_query(
    hyperdrive: Hyperdrive,
    sql: &'static str,
) -> Result<Vec<SimpleQueryMessage>, ProbeError> {
    // Pattern đã được thí nghiệm xác nhận (Issue #22, criteria 3): socket qua
    // Socket API của Worker với StartTls, workerd dial thẳng tới database với
    // `sslmode=disable` (platform facts PF3/PF4). host/port lấy từ binding,
    // KHÔNG log.
    let socket = Socket::builder()
        .secure_transport(SecureTransport::StartTls)
        .connect(hyperdrive.host(), hyperdrive.port())
        .map_err(|_| ProbeError::Socket)?;
    let config = hyperdrive
        .connection_string()
        .parse::<tokio_postgres::Config>()
        .map_err(|_| ProbeError::Config)?;
    let (client, connection) = config
        .connect_raw(socket, PassthroughTls)
        .await
        .map_err(|_| ProbeError::Connect)?;

    // Race query với connection: bình thường câu lệnh trả lời trước rồi
    // connection bị drop (đóng socket); nếu connection ngắt sớm (auth lỗi,
    // socket đứt) thì coi như không sẵn sàng. Nhờ vậy không cần driver nền
    // riêng và probe gọn trong một future có timeout bọc ngoài.
    // Hai future này không Unpin (state nội bộ của tokio-postgres), nên ghim
    // stack trước khi `select`; `Pin<&mut _>` tự Unpin nên thỏa mãn bound.
    let mut query = pin!(client.simple_query(sql));
    let mut connection = pin!(connection);
    match select(query.as_mut(), connection.as_mut()).await {
        Either::Left((rows, _)) => rows.map_err(|_| ProbeError::Query),
        Either::Right((connection_error, _)) => {
            // Connection ngắt trước khi query trả lời — chi tiết lỗi không log.
            let _ = connection_error;
            Err(ProbeError::Connect)
        }
    }
}

async fn probe_binding(hyperdrive: Hyperdrive) -> Result<(), ProbeError> {
    let rows = binding_simple_query(hyperdrive, "SELECT 1").await?;
    if rows
        .iter()
        .any(|message| matches!(message, SimpleQueryMessage::Row(_)))
    {
        Ok(())
    } else {
        Err(ProbeError::NoRow)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_is_ready_only_when_all_three_bindings_are_ready() {
        let report = ReadinessReport {
            gateway: BindingStatus::Ready,
            tenant: BindingStatus::Ready,
            marketplace: BindingStatus::Ready,
        };
        assert!(report.is_ready());
    }

    #[test]
    fn any_non_ready_binding_fails_the_whole_report() {
        let report = ReadinessReport {
            gateway: BindingStatus::Ready,
            tenant: BindingStatus::TimedOut,
            marketplace: BindingStatus::Ready,
        };
        assert!(!report.is_ready());
    }

    #[test]
    fn timed_out_binding_is_reported_with_its_name_in_declaration_order() {
        let report = ReadinessReport {
            gateway: BindingStatus::Ready,
            tenant: BindingStatus::Missing,
            marketplace: BindingStatus::TimedOut,
        };
        let failures = report.failures();
        assert_eq!(failures.len(), 2);
        assert_eq!(failures[0], (BINDING_TENANT, BindingStatus::Missing));
        assert_eq!(failures[1], (BINDING_MARKETPLACE, BindingStatus::TimedOut));
    }

    #[test]
    fn ready_report_has_no_failures() {
        let report = ReadinessReport {
            gateway: BindingStatus::Ready,
            tenant: BindingStatus::Ready,
            marketplace: BindingStatus::Ready,
        };
        assert!(report.failures().is_empty());
    }

    #[test]
    fn binding_status_labels_are_english_runtime_words() {
        assert_eq!(BindingStatus::Ready.label(), "ready");
        assert_eq!(BindingStatus::Unavailable.label(), "unavailable");
        assert_eq!(BindingStatus::Missing.label(), "missing");
        assert_eq!(BindingStatus::TimedOut.label(), "timeout");
    }
}
