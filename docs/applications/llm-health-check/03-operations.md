# LLM Health Check Job — 03 Operations

> **Phạm vi:** vận hành deploy unit `llm-health-check` — schedule, config, probe execution, reporting, failure handling, recovery, runbook. System-level ops → [`docs/architecture/03-operations.md`](../../architecture/03-operations.md). Policy deploy/rollback/secrets → [`docs/architecture/02-delivery.md`](../../architecture/02-delivery.md). Invariant kiến trúc → [`01-architecture.md`](./01-architecture.md). Yêu cầu → [`02-requirements.md`](./02-requirements.md).

Job thuộc **operations plane**: chỉ đo và báo evidence health cho `UpstreamEndpoint` của `llm-marketplace`. Không sở hữu endpoint config/catalog, không routing, không quota/settlement, không eligibility. Health status (`healthy` | `degraded` | `down`) là business state của `UpstreamEndpoint` thuộc `llm-marketplace`; job chỉ cung cấp evidence.

---

## 1. Runtime, deployment và configuration

Deploy unit gồm các resource sau (thiếu binding/secret nào thì job fail-closed mỗi run — `01-architecture.md` §4, §10):

```text
Worker / runner        — llm-health-check (scheduled handler; không public HTTP API)
Scheduler trigger      — cron schedule (giá trị khởi điểm lúc deploy; chưa load-test)
Job state store        — durable state của job (riêng của job; không truy cập DB marketplace)
Service Binding / API  — contract probe-report tới llm-marketplace (private)
```

- Worker **không** expose public HTTP API và **không** truy cập DB của `llm-marketplace` hay service khác (`01-architecture.md` §9, §14 #6). Đọc endpoint list và ghi health result **chỉ** qua contract của `llm-marketplace`.
- Worker không giữ provider credential; probe **không** gửi credential provider (`01-architecture.md` §6, §12; `02-requirements.md` FR-012, SR-002).
- Job state store là storage authoritative của job; mất instance Worker không mất state. Dữ liệu job state không business-critical → recovery ở mức service (`01-architecture.md` §2.2).
- Rollout/rollback Worker version → [`docs/architecture/02-delivery.md`](../../architecture/02-delivery.md) §7–§8. Job không giữ state nào khó rollback; run đứt giữa chừng thì run kế tiếp tiếp tục xử lý.

### 1.1 Checklist cô lập staging/production (gate trước production)

Cô lập enforce bằng runtime configuration/binding, không phải tài liệu. Một mục chưa thoả là blocker release.

| Resource / environment                                    | Trạng thái hôm nay                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Job state store (staging vs production)                   | **chưa thoả** — chưa có deployment; phải tách riêng theo environment                    |
| Scheduler trigger / cron                                  | **chưa thoả** — handler + schedule đã chốt thiết kế; chưa xác minh trên runtime         |
| Credential job principal (probe-report contract)          | **chưa thoả** — chưa provision theo environment                                         |
| Service Binding / contract endpoint tới `llm-marketplace` | **chưa thoả** — phải trỏ cùng environment, không cross-environment                      |
| Public ingress                                            | **thoả ở config** — không public HTTP API; giữ nguyên nếu không thêm route/fetch export |

- **Cross-environment là blocker.** Job principal của staging không được gọi contract production của `llm-marketplace`; Service Binding phải trỏ tới deployment cùng environment (platform fact PW4).
- **Secret không vào Git/PR/Preview** (`docs/architecture/02-delivery.md` §6).

### 1.2 Trạng thái của trigger — bốn tầng, phải phân biệt

Cơ chế trigger chốt là **scheduled handler của chính Worker này** (`docs/architecture/03-operations.md` §10; `01-architecture.md` §5). Chốt cơ chế ≠ wiring:

| Tầng                                        | Trạng thái hôm nay                                              |
| ------------------------------------------- | --------------------------------------------------------------- |
| (1) Quyết định thiết kế                     | ✔ Scheduled handler của chính Worker này; hỗ trợ manual trigger |
| (2) Cấu hình (`wrangler.jsonc` / scheduler) | ✖ Chưa khai — giá trị khởi điểm lúc deploy                      |
| (3) Implement (`scheduled()`)               | ✖ Chưa implement                                                |
| (4) Xác minh trên runtime                   | ✖ Chưa xác minh                                                 |

- Nhịp cron là giá trị khởi điểm lúc deploy, không phải con số đã load-test; đổi nhịp là thay config trong một PR, không đụng thuật toán.
- Manual trigger dành cho operator recovery (FR-001); không tạo endpoint mới, chỉ probe endpoint đã tồn tại và eligible.

---

## 2. Scheduling và triggering

- Trigger chính là schedule định kỳ (cron); manual trigger cho operator recovery (`01-architecture.md` §5; FR-001).
- Trigger không tạo endpoint mới; chỉ probe endpoint đã tồn tại và eligible (FR-002).
- **Re-entrancy:** run mới không chồng lên run đang chạy cho cùng endpoint nếu chưa kết thúc; tránh duplicate probe (FR-010).
- **Backpressure:** nếu backlog probe lớn, ưu tiên endpoint có health status stale hoặc critical (§5 arch).
- Mỗi run probe một tập endpoint; không probe toàn bộ catalog nếu không cần (FR-002).
- Run có thể bị hủy/timeout; job state ghi nhận tiến độ để resume (NFR-001).

---

## 3. Configuration (canonical)

Job không có default ngầm cho các giá trị vận hành quan trọng — thiếu/sai thì fail-closed lúc boot/run. Tên biến đúng như loader đọc (chưa implement; khi implement phải khớp bảng này).

| Biến / binding                      | Loại             | Bắt buộc | Mô tả                                                                                                                                                                   |
| ----------------------------------- | ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler trigger / cron            | scheduler config | Có       | Nhịp probe định kỳ; giá trị khởi điểm lúc deploy                                                                                                                        |
| Job state store binding             | binding          | Có       | Storage durable cho progress/state job                                                                                                                                  |
| Contract credential (job principal) | secret           | Có       | Authenticate tới probe-report contract của `llm-marketplace`; least privilege (SR-003, SR-004)                                                                          |
| `PROBE_CONCURRENCY`                 | config           | Có       | Trần concurrency probe (FR-009, NFR-004)                                                                                                                                |
| `PROBE_TIMEOUT_MS`                  | config           | Có       | Timeout hữu hạn mỗi probe (FR-003, NFR-002)                                                                                                                             |
| `RATE_LIMIT_PER_HOST`               | config           | Có       | Rate limit per host/endpoint (FR-009)                                                                                                                                   |
| `RETRY_MAX_ATTEMPTS`                | config           | Có       | Bound retry cho probe failure tạm thời (FR-008)                                                                                                                         |
| `RETRY_BACKOFF`                     | config           | Có       | Backoff bounded (FR-008)                                                                                                                                                |
| `ENDPOINT_SELECTION_POLICY`         | config           | Có       | Chính sách chọn endpoint eligible và đến hạn refresh (FR-002)                                                                                                           |
| `SSRF_ALLOWLIST` / host allowlist   | config           | Có       | Scheme/host/port allowlist + DNS resolution policy (chặn IP private/loopback/link-local, timeout, max redirect hops, userinfo forbidden) cho probe URL (FR-011, SR-001) |
| `LOG_LEVEL`                         | config           | Có       | Mức log                                                                                                                                                                 |

- **Không hard-code** method/timeout/expected status/body assertion trong probe code; các giá trị này do policy cấu hình (`01-architecture.md` §6).
- Worker **không** giữ provider credential và probe **không** gửi credential provider (FR-012, SR-002).
- Secret của job principal lưu dạng secret theo environment; không vào Git/PR/Preview (`docs/architecture/02-delivery.md` §6).

---

## 4. Probe execution, concurrency và rate limit

- Probe chỉ endpoint có health status cần refresh hoặc đến hạn probe (FR-002).
- Method/timeout/expected status/body assertion do policy cấu hình (FR-003).
- Không follow redirect ngoài allowlist; redirect coi là failure class (`01-architecture.md` §6, SR-001).
- Không gửi credential provider; probe là health check, không phải request suy luận (FR-012, SR-002).
- Kết quả classify: `healthy`, `degraded`, `down` dựa trên status code/latency/error class, không dựa trên nội dung business (FR-004).
- **Concurrency bounded** theo config; không probe không giới hạn (FR-009, NFR-004).
- **Rate limit per host/endpoint** để tránh DDoS upstream (FR-009).
- Provider throttling → giảm concurrency, không tăng (`01-architecture.md` §11).
- Không phá idempotency; duplicate probe an toàn (FR-014).

---

## 5. Reporting tới llm-marketplace (contract)

- `llm-marketplace` là owner của `UpstreamEndpoint` và health status (FR-007, SR-003).
- Job đọc endpoint list và ghi health result qua contract (API/event), không truy cập DB marketplace (FR-006, SR-003).
- Contract phải **idempotent** theo `endpoint_id` + `probe_at`/run id (FR-014).
- Job không gọi Admin API marketplace; chỉ endpoint probe-report contract (SR-003).
- Job không tự chuyển offer active/inactive; không chuyển endpoint pool state (`01-architecture.md` §8).
- Health status transition (`healthy ↔ degraded ↔ down`) do `llm-marketplace` thực hiện theo evidence (FR-007).
- Evidence tối thiểu mỗi probe: `endpoint_id`, `probe_at`, `latency_ms`, `http_status`, `error_class`, `result` (FR-005). Evidence không chứa secret (SR-002).

---

## 6. Error classification và retry/backoff

**Error matrix canonical của job này** (`01-architecture.md` §10; FR-008):

| Loại outcome                                                    | Nhận diện                                             | Retry?                                                    | Runbook   |
| --------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- | --------- |
| `healthy` / `degraded` / `down` (probe thành công có phân loại) | Probe trả kết quả hợp lệ                              | —                                                         | Không cần |
| Probe failure tạm thời                                          | timeout, 5xx, network error                           | Có — bounded + backoff                                    | §9.1      |
| Probe failure vĩnh viễn                                         | DNS invalid, TLS fail, 4xx                            | Không — classify `down`/`degraded`                        | §9.2      |
| Job failure (scheduler crash)                                   | Worker crash                                          | Run tiếp theo xử lý; không mất state durable              | §9.3      |
| Contract/report failure                                         | `llm-marketplace` unavailable, 5xx/timeout khi report | Retry bounded; không block completion nếu policy cho phép | §9.4      |
| SSRF violation                                                  | URL không qua allowlist                               | Không retry; classify failure; alert                      | §9.5      |

- Retry **bounded**; không retry vô hạn (FR-008, NFR-001).
- Job failure (scheduler crash) → run tiếp theo xử lý; không mất state durable (NFR-001).
- Probe failure vĩnh viễn (DNS invalid, TLS fail, 4xx) → classify `down`/`degraded`, không retry vô hạn (`01-architecture.md` §10).
- Probe failure tạm thời (timeout, 5xx, network) → retry với backoff bounded (`01-architecture.md` §10).
- Duplicate probe an toàn (idempotent contract) (FR-014).

---

## 7. Observability

System-wide observability (Axiom, dataset, retention, privacy) → [`docs/architecture/03-operations.md`](../../architecture/03-operations.md) §4. Tại đây chỉ metric/điều kiện của job:

**Metric tối thiểu:**

- Probe success/failure count · latency (p50/p95/p99)
- Health status distribution (`healthy`/`degraded`/`down`)
- Run duration · run missed count
- Endpoint selection count · stale endpoint count
- Report success/failure · retry count
- SSRF rejection count · concurrency saturation

**Log:** structured, mỗi probe có correlation id; evidence không chứa secret (SR-002). Không log prompt/response body (system-level rule).

**Alert:**

```text
Probe failure spike
Stale health (endpoint không được refresh quá ngưỡng)
Run missed (scheduled run không chạy)
Report failure kéo dài (contract tới llm-marketplace fail)
SSRF rejection tăng bất thường
```

Alert aggregate theo endpoint/host/error class where appropriate; không alert theo một probe failure đơn lẻ trừ khi spike.

---

## 8. Failure handling

| Sự cố                                  | Hành vi                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Endpoint unreachable / timeout         | Classify `down`/`degraded`; retry bounded nếu failure tạm thời               |
| Provider throttling (429)              | Giảm concurrency; không tăng; retry với backoff                              |
| `llm-marketplace` contract unavailable | Retry report bounded; job state ghi nhận tiến độ; không mất evidence durable |
| Job crash giữa run                     | Run tiếp theo xử lý; job state durable; không mất evidence đã ghi            |
| SSRF violation attempt                 | Từ chối probe; classify failure; alert; không retry                          |
| Backlog probe lớn                      | Backpressure: ưu tiên endpoint stale/critical                                |

- **Health status không imply quota/financial/eligibility** (`01-architecture.md` invariant #3). Job không routing/quota (FR-013).
- Build correctness / routing không phụ thuộc job availability; job là operations plane, không tham gia request path suy luận (`01-architecture.md` §3).

---

## 9. Recovery và runbook

### 9.1 Probe failure tạm thời (timeout, 5xx, network)

1. Kiểm tra endpoint reachability và provider health.
2. Kiểm tra concurrency/rate limit có đang throttling không.
3. Rerun probe (manual trigger) sau khi nguyên nhân xử lý.
4. Nếu lặp lại nhiều run → điều chỉnh policy timeout/backoff/concurrency qua config PR.

### 9.2 Probe failure vĩnh viễn (DNS invalid, TLS fail, 4xx)

1. Verify endpoint URL và DNS/TLS configuration ở `llm-marketplace` (job không sửa endpoint config).
2. Classify `down`/`degraded` là đúng thiết kế; không retry vô hạn.
3. Sau khi marketplace sửa endpoint, run tiếp theo sẽ refresh.

### 9.3 Job crash / run missed

1. Kiểm tra scheduler trigger và Worker runtime.
2. Manual trigger để catch up.
3. Job state durable nên run tiếp theo xử lý backlog; ưu tiên endpoint stale/critical (backpressure).
4. Nếu crash lặp lại → điều tra runtime/timeout/config.

### 9.4 Contract/report failure (llm-marketplace unavailable)

1. Kiểm tra `llm-marketplace` health và contract endpoint.
2. Job retry report bounded; evidence durable ở job state store.
3. Sau khi marketplace khôi phục, rerun/manual trigger để drain pending report.
4. Không tự sửa health status; transition thuộc marketplace.

### 9.5 SSRF violation

1. Kiểm tra endpoint URL trong marketplace có vi phạm allowlist không.
2. Job từ chối probe; alert operator.
3. Sửa endpoint config ở `llm-marketplace` (không phải job); không nới allowlist để "cho chạy".

### 9.6 Reconcile stale endpoints

1. Identify endpoints có health status stale (không refresh quá ngưỡng).
2. Manual trigger với backpressure ưu tiên stale/critical.
3. Verify report thành công và marketplace cập nhật health status.
4. Nếu vẫn stale → kiểm tra contract/report path và endpoint eligibility.

---

## 10. Security / SSRF

- Endpoint URL phải validate scheme (http/https) và host allowlist theo policy; không probe URL arbitrary (FR-011, SR-001).
- Không probe localhost/internal IP trừ khi allowlist rõ ràng (SR-001).
- Không follow redirect tới host ngoài allowlist (SR-001).
- Không gửi provider credential; probe request không chứa secret (FR-012, SR-002).
- Job principal authenticates to marketplace contract; least privilege (SR-004, SR-003).
- Evidence không chứa secret (SR-002).
- Secret không vào Git/PR/Preview (`docs/architecture/02-delivery.md` §6).

---

## 11. Operational invariants

Operator MUST giữ:

1. Job không sở hữu endpoint config/catalog/offer; health status là business state của marketplace (invariant #1, #2).
2. Health status không imply quota/financial/eligibility (invariant #3).
3. Probe không gửi credential; SSRF guarded (invariant #4).
4. Retry bounded; concurrency bounded (invariant #5).
5. Contract idempotent; không truy cập DB marketplace (invariant #6).
6. Circuit breaker runtime (nếu có) không phải BC mới và không thuộc job (invariant #7).
7. Job không tham gia request path suy luận; không routing/quota (FR-013).
8. Job state durable; crash không mất state (NFR-001).
9. Secret không trong evidence/log.

Invariant kiến trúc đầy đủ → [`01-architecture.md`](./01-architecture.md) §14.
