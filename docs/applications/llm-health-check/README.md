# LLM Health Check — Application

`llm-health-check` là job vận hành probe health cho các `UpstreamEndpoint` do `llm-marketplace` sở hữu. Job thuộc **operations plane** — chỉ đo và báo evidence health; không sở hữu offer/endpoint config/catalog, không routing, không quota/settlement, không eligibility.

> `llm-health-check` chỉ đo và báo health evidence. Ý nghĩa business của `UpstreamEndpoint.health_status` và state transitions thuộc `llm-marketplace` → [`docs/domains/llm-marketplace/domain-model.md`](../../domains/llm-marketplace/domain-model.md). Không định nghĩa transition tại đây.

## Runtime

```text
llm-health-check job
├── Scheduler / runner
├── Probe execution worker
└── Job state store (riêng của job)
```

- Chỉ đọc endpoint cần probe và ghi health result qua contract của `llm-marketplace`; không truy cập DB của marketplace.
- Health status (`healthy` | `degraded` | `down`) là business state thuộc `UpstreamEndpoint` của `llm-marketplace`.
- Circuit breaker runtime (nếu có) thuộc capability của `llm-api`/routing plane, không phải BC mới và không phải trách nhiệm của job này.

## Documents

| Document                                     | Nội dung                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`01-architecture.md`](./01-architecture.md) | Boundary, lifecycle, scheduling, probing, evidence, state transition, contract, retry, concurrency, SSRF |
| [`02-requirements.md`](./02-requirements.md) | FR/NFR/SR và non-goals                                                                                   |
| [`03-operations.md`](./03-operations.md)     | Schedule, config, failure modes, observability, recovery, runbook                                        |
