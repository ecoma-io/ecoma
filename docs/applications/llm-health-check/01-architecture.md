# LLM Health Check Job — 01 Architecture

> **Phạm vi:** boundary, lifecycle, scheduling, probing policy, health evidence, state transition, contract với `llm-marketplace`, retry/backoff, concurrency/rate limit, SSRF. Yêu cầu → [`02-requirements.md`](./02-requirements.md) · vận hành → [`03-operations.md`](./03-operations.md).

## 1. Mục đích

`llm-health-check` là job probe health cho các `UpstreamEndpoint` của `llm-marketplace`. Job chỉ **đo và báo evidence**; nó không sở hữu endpoint config/catalog, không routing, không quota/settlement, không eligibility. Health status (`healthy` | `degraded` | `down`) là business state của `UpstreamEndpoint` thuộc `llm-marketplace` (→ `docs/domains/llm-marketplace/domain-model.md` §3.4).

```text
Scheduler → llm-health-check job → UpstreamEndpoint (HTTP probe)
                  │
                  └── health result → llm-marketplace (contract) → UpstreamEndpoint.health_status
```

## 2. Phạm vi

### 2.1 Trong phạm vi

- Lên lịch và kích hoạt probe cho tập endpoint eligible.
- Thực hiện HTTP probe theo policy (method, timeout, expected status, body check nếu có).
- Ghi nhận health evidence (timestamp, latency, status code, error class).
- Báo kết quả health về `llm-marketplace` qua contract; không tự ghi DB marketplace.
- Retry/backoff khi probe thất bại tạm thời; concurrency/rate limit khi probe.
- Boundary SSRF khi probe endpoint URL.

### 2.2 Ngoài phạm vi

- Sở hữu seller offer/endpoint config/catalog → `llm-marketplace`.
- Routing candidate selection/fallback → `llm-consumer-routing` / `llm-api`.
- Quota/usage/settlement → `llm-api` (A7).
- Eligibility customer-facing → `llm-api`.
- Circuit breaker runtime capability (nếu có) thuộc `llm-api`/routing plane, không phải BC mới.
- Backup/DR của job state (nếu job state không business-critical, recovery ở mức service).

## 3. Vai trò trong plane

Job thuộc **operations plane**. Nó không tham gia request path suy luận; health evidence chỉ là input cho routing/eligibility do các plane khác quyết định. Health status **không** đồng nghĩa với quota/financial/eligibility state.

## 4. Lifecycle của job

```text
Trigger (schedule/manual) → Select eligible endpoints → Probe (bounded concurrency) → Classify result → Report health evidence → Update job state → Ack completion
```

- Mỗi run probe một tập endpoint; không probe toàn bộ catalog nếu không cần.
- Run có thể bị hủy/timeout; job state ghi nhận tiến độ để resume.
- Kết quả chỉ là evidence; không tự chuyển offer active/inactive (thuộc marketplace).

## 5. Scheduling / triggering

- Schedule định kỳ (cron) là trigger chính; manual trigger cho operator recovery.
- Trigger không tạo endpoint mới; chỉ probe endpoint đã tồn tại và eligible.
- Re-entrancy: run mới không chồng lên run đang chạy cho cùng endpoint nếu chưa kết thúc; tránh duplicate probe.
- Backpressure: nếu backlog probe lớn, ưu tiên endpoint có health status stale hoặc critical.

## 6. Endpoint probing policy

- Probe chỉ endpoint có `health_status` cần refresh hoặc đến hạn probe.
- Method/timeout/expected status/body assertion do policy cấu hình, không hard-code trong probe code.
- Không follow redirect ngoài allowlist; redirect coi là failure class.
- Không gửi credential provider; probe là health check, không phải request suy luận.
- Kết quả classify: `healthy`, `degraded`, `down` dựa trên status code/latency/error class, không dựa trên nội dung business.

## 7. Health evidence

Evidence tối thiểu mỗi probe: `endpoint_id`, `probe_at`, `latency_ms`, `http_status`, `error_class`, `result` (`healthy`/`degraded`/`down`). Evidence dùng để audit và reconciliation; không chứa secret.

## 8. State transitions

- Job chỉ báo evidence; `UpstreamEndpoint.health_status` transition (`healthy ↔ degraded ↔ down`) do `llm-marketplace` thực hiện theo evidence.
- Job không chuyển offer active/inactive; không chuyển endpoint pool state.
- Health status không imply quota/financial/eligibility.

## 9. Contract với resource-owning service

- `llm-marketplace` là owner của `UpstreamEndpoint` và health status.
- Job đọc endpoint list và ghi health result qua contract (API/event), không truy cập DB marketplace.
- Contract phải idempotent theo `endpoint_id` + `probe_at`/run id.
- Job không gọi Admin API marketplace; chỉ endpoint probe-report contract.

## 10. Failure / retry / backoff

- Probe failure tạm thời (timeout, 5xx, network) → retry với backoff bounded.
- Probe failure vĩnh viễn (DNS invalid, TLS fail, 4xx) → classify `down`/`degraded`, không retry vô hạn.
- Job failure (scheduler crash) → run tiếp theo xử lý; không mất state durable.
- Retry bounded; không retry vô hạn.

## 11. Concurrency / rate limiting khi probe

- Probe concurrency bounded theo config; không probe không giới hạn.
- Rate limit per host/endpoint để tránh DDoS upstream.
- Provider throttling → giảm concurrency, không tăng.
- Không phá idempotency; duplicate probe an toàn.

## 12. Security / SSRF boundaries

- Endpoint URL phải parse canonical và validate scheme (http/https), host allowlist, port và không có userinfo; mỗi redirect hop phải qua cùng kiểm tra; DNS resolution phải chặn IP private/loopback/link-local (chống DNS rebinding).
- Không probe localhost/internal IP trừ khi allowlist rõ ràng.
- Không follow redirect tới host ngoài allowlist.
- Không gửi provider credential; probe request không chứa secret.
- Job principal authenticates to marketplace contract; least privilege.

## 13. Observability / operational recovery

- Metric: probe success/failure, latency, health status distribution, run duration.
- Alert: probe failure spike, stale health, run missed.
- Recovery: rerun probe, manual trigger, reconcile stale endpoints.
- Runbook → `03-operations.md`.

## 14. Invariants

1. Job không sở hữu endpoint config/catalog/offer.
2. Health status là business state của marketplace, job chỉ evidence.
3. Health status không imply quota/financial/eligibility.
4. Probe không gửi credential; SSRF guarded.
5. Retry bounded; concurrency bounded.
6. Contract idempotent; không truy cập DB marketplace.
7. Circuit breaker runtime (nếu có) không phải BC mới và không thuộc job.
