# LLM Health Check Job — 02 Requirements

> **Phạm vi:** FR/NFR/SR và non-goals của `llm-health-check`. Design → [`01-architecture.md`](./01-architecture.md) · vận hành → [`03-operations.md`](./03-operations.md).

## 1. Functional Requirements

- **FR-001 — Scheduling.** Job MUST lên lịch probe định kỳ và hỗ trợ manual trigger.
- **FR-002 — Endpoint selection.** Job MUST chỉ probe endpoint eligible và đến hạn refresh; MUST NOT probe toàn bộ catalog mỗi run.
- **FR-003 — Probing.** Job MUST thực hiện HTTP probe với timeout hữu hạn, method/expected status/body assertion theo policy.
- **FR-004 — Classification.** Job MUST classify kết quả thành `healthy`/`degraded`/`down` dựa trên status code/latency/error class.
- **FR-005 — Evidence.** Job MUST ghi evidence mỗi probe: `endpoint_id`, `probe_at`, `latency_ms`, `http_status`, `error_class`, `result`.
- **FR-006 — Reporting.** Job MUST báo health result về `llm-marketplace` qua contract idempotent; MUST NOT tự ghi DB marketplace.
- **FR-007 — State ownership.** `UpstreamEndpoint.health_status` transition do `llm-marketplace` thực hiện; job chỉ evidence.
- **FR-008 — Retry.** Probe failure tạm thời MUST retry bounded với backoff; failure vĩnh viễn MUST NOT retry vô hạn.
- **FR-009 — Concurrency.** Probe concurrency MUST bounded; rate limit per host.
- **FR-010 — Re-entrancy.** Run mới MUST NOT chồng lên run đang chạy cho cùng endpoint.
- **FR-011 — SSRF.** Endpoint URL MUST validate scheme (http/https), host allowlist, port (no userinfo), DNS resolution policy (block private/loopback/link-local), and bounded redirect hops; MUST NOT probe arbitrary URL.
- **FR-012 — No credential.** Probe MUST NOT gửi provider credential; evidence MUST NOT chứa secret.
- **FR-013 — No routing/quota.** Job MUST NOT routing, quota, settlement, eligibility.
- **FR-014 — Idempotency.** Contract report MUST idempotent theo một khóa canonical duy nhất: `endpoint_id` + `run_id` (kèm `probe_at` để audit); marketplace MUST dùng cùng khóa, không tự suy từ timestamp.

## 2. Non-Functional Requirements

- **NFR-001 — Reliability.** Job MUST tolerate crash/restart without losing durable state; run tiếp theo xử lý.
- **NFR-002 — Performance.** Probe MUST có timeout hữu hạn; không unbounded execution.
- **NFR-003 — Security.** SSRF guarded; secret không trong evidence/log.
- **NFR-004 — Scalability.** Concurrency bounded; không probe không giới hạn.
- **NFR-005 — Observability.** Metric/alert cho probe success/failure, latency, stale health, run missed.

## 3. Security Requirements

- **SR-001 — SSRF.** URL phải parse canonical và validate scheme (http/https), host allowlist, port và không có userinfo; mỗi redirect hop qua cùng kiểm tra; DNS resolution chặn IP private/loopback/link-local (chống DNS rebinding); không follow redirect ngoài allowlist; không probe localhost/internal IP trừ allowlist rõ ràng.
- **SR-002 — No credential.** Probe không gửi provider credential; evidence không chứa secret.
- **SR-003 — Least privilege.** Job chỉ probe-report contract; không Admin API marketplace; không truy cập DB marketplace.
- **SR-004 — Auth.** Job principal authenticates to marketplace contract; verify trước khi xử lý.

## 4. Non-goals

- Không sở hữu seller offer/endpoint config/catalog.
- Không routing/reroute/fallback.
- Không quota/usage/settlement.
- Không eligibility customer-facing.
- Không circuit breaker runtime capability (thuộc routing plane, không phải BC mới).
- Không health status imply quota/financial/eligibility.
