# llm-api — 03 Operations

> Deployment, configuration, monitoring, failure, recovery, runbook của deploy unit `llm-api`. System-level ops → [`docs/architecture/03-operations.md`](../../architecture/03-operations.md).

## 1. Deployment

- Deploy unit: Cloudflare Worker `llm-api` tại `api.ecoma.io/llm`.
- Runtime: TypeScript high-perf data plane (control plane chưa dựng); Worker binding Hyperdrive tới `db-llm-gateway`.
- Migration: expand → compatible rollout → contract; migration runner từ CI, không từ Worker.
- Rollback = rollback Worker version đã publish; không rollback DB.

## 2. Configuration

- **Static:** env vars/binding (limit artifact, log level, Hyperdrive binding, provider timeout, keepalive). Chi tiết key → deployment config.
- **Dynamic:** API key, quota policy, alias/routing, pricing, provider endpoint — control plane, cached trong data plane.
- **Secrets:** native Worker Secrets theo env; không vào Git/PR/Preview.

## 3. Monitoring

- Correlation ID xuyên client→Worker→provider→DB.
- Metrics: auth failure, backend error, quota conservation violation, settlement backlog age, unsettled usage, 5xx ratio, stream keepalive.
- Axiom dataset tách env; traceparent xuyên hop.
- Alert theo [`docs/architecture/03-operations.md`](../../architecture/03-operations.md) §5 (Page/Ticket).

## 4. Failure handling

| Sự cố               | Hành vi                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| PostgreSQL down     | Fail closed request mới (503 + Retry-After); stream đang chạy hoàn tất → settlement debt |
| Provider failure    | Retry/fallback theo evidence; `may_have_executed` không blind retry                      |
| Missing usage       | Ghi durable + alert; không block completion nếu policy cho phép                          |
| No-candidate        | Lỗi tường minh; release reservation nếu đã reserve                                       |
| Hyperdrive pool cạn | 503 + Retry-After; load shedding, không queue chờ                                        |

⚠️ Deviation ghi nhận được (M1): dòng trên là policy vận hành đích của control plane chưa xây. Data plane M1 hiện chạy admission per-binding trong từng isolate — limit hữu hạn + queue bounded + deadline operation — nên quá tải luôn kết thúc xác định bằng 503 (queue đầy → fail-fast ngay; deadline → timeout), không bao giờ queue vô hạn. Deviation nằm trong source (`src/connections.ts`) và được thay khi control plane xây xong.

## 5. Recovery

- Restore DB theo system-level runbook (base backup + WAL → R2, PITR).
- Repoint Hyperdrive origin bằng PATCH (không PUT) sau restore.
- Verify invariants qua đường Hyperdrive: tổng debit = tổng credit; `settled + active_reservation ≤ grant`; migration version đúng.
- Reconciliation on-demand sau recovery.

## 6. Settlement debt

Khi PG down, stream hoàn tất và usage phát sinh nhưng settlement không ghi được. Fail closed cho request mới. Settlement backlog age là operational signal. Mục tiêu đã chốt: settlement debt phải settle đủ — không mất (ADR-0028 §5, OB-3); nhánh "chấp nhận thất thoát" đã bị loại, chỉ còn mở ở cơ chế recovery (RPO/batching/window) — xem system-level §3.2b.

## 7. Runbook (short)

- Alert quota conservation violation → investigate settlement/idempotency; không tự sửa số liệu.
- Alert settlement backlog age tăng → kiểm tra PG connectivity, drain backlog.
- Alert provider error rate → kiểm tra provider health, circuit state, fallback.
- Restore drill hằng tháng + rebuild drill 6 tháng (system-level §3.4).
