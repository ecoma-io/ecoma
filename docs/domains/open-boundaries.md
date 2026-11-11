# Open Boundaries

> **Phạm vi:** chỉ những **ranh giới nghiệp vụ** thật sự chưa có đáp án. Mỗi mục nêu câu hỏi, context liên quan, điều đã chốt, điều chưa chốt và nguồn quyết định hiện có.
>
> Không đưa technical implementation uncertainty, deployment blocker hay runbook issue vào đây — chúng thuộc Application document hoặc [`architecture/01-architecture.md`](../architecture/01-architecture.md) §10. Quyết định đã chốt bằng ADR **không** được liệt kê lại như open; chỉ phần chưa chốt tường minh của nó mới ở đây.
>
> Catalog → [`README.md`](./README.md). Quan hệ → [`context-map.md`](./context-map.md).

## OB-1. Hợp đồng crediting / reconciliation / settlement giữa `payment` và LLM product

**Contexts:** `payment`, `llm-financial`, `llm-usage`, `llm-consumer-tenant`

- **Đã chốt:** phân chia trách nhiệm — `payment` sở hữu payment transaction và payout execution; `llm-consumer-tenant` sở hữu quota policy/limits; `llm-usage` sở hữu usage measurement; `llm-financial` sở hữu LLM monetary state. Cơ chế reserve/settle của gateway là Application concern với PostgreSQL là quota authority (A7). Cấp nguồn lực **nội bộ first-party** đã chốt: sponsor funding qua bút toán kép có authorization và trần, sponsor/billing account/bootstrap tài chính thuộc `llm-financial` ([ADR-0028](./llm-financial/adr/0028-internal-sponsorship-funding-first-party-financial-model.md)).
- **Chưa chốt (phần còn của đường `payment`):** credit từ `payment` liên quan thế nào tới quota của LLM product (không kết luận có cơ chế cấp quota tự động); ledger credit và quota usage là một đại lượng hay hai; quan hệ giữa credit/seller payout và settlement của gateway (không phát minh refund/chargeback semantics); reconciliation giữa hai nguồn sự thật; có cần direct call giữa hai context hay không và theo hướng nào; provisioning billing account cho tenant customer ngoài bootstrap. Phần tài trợ nội bộ first-party **không** còn mở — đã chốt ở ADR-0028.
- **Vì sao quan trọng:** ngầm giả định "payment tự tạo quota" hoặc "cùng source of truth" sẽ vi phạm A7 và data ownership.
- **Nguồn:** [`architecture/01-architecture.md`](../architecture/01-architecture.md) §4, A7, invariant 16, [`03`](../architecture/03-operations.md) §3.2b.

## OB-2. Lan truyền entitlement và revocation latency của `staff-access`

**Contexts:** `staff-access`, mọi resource-owning context

- **Đã chốt:** [ADR-0009](./staff-access/adr/0009-no-internal-authorization-result-contract.md) — không có contract nhận kết quả authorization, không sync call per request, chỉ batch/event-based sync; backend tự enforce với dữ liệu nó có. [ADR-0002](./staff-access/adr/0002-revocation-latency-risk-class.md) — target `normal` ≤ 60s, `high` ≤ 5s. [ADR-0014](./staff-access/adr/0014-revocation-sla-mechanism.md) — event-driven invalidation với deadline delivery theo event class, freshness bound + fail-closed, re-check-at-write-time cho write path. Ba ADR phải đọc cùng nhau.
- **Phân biệt bắt buộc:** entitlement event truyền **tính khả dụng sản phẩm**, không phải verdict allow/deny cho từng request và không mang permission list hay per-resource scope.
- **Chưa chốt:** hình thức cụ thể của kênh batch/event-based sync (outbox event, batch pull, projection do backend giữ) và cách đo/verify target trong runtime.
- **Vì sao quan trọng:** ADR-0009 chốt **hình dạng** và ADR-0014 chốt **cơ chế SLA**; deadline phân class là ràng buộc mọi hình thức phải đáp ứng. Âm thầm hạ SLA hoặc biến target ≤5s thành giả định là vi phạm A24. Delivery qua Cloudflare Queues là at-least-once, unordered, batch retry (QU1/QU4) nên Queues đơn thuần không bảo đảm ≤5s.
- **Nguồn:** `staff-access/adr/0009`, `0002`, `0014`; [`architecture/04-platform-facts.md`](../architecture/04-platform-facts.md) QU1/QU4.

## OB-3. Settlement debt — cơ chế store bền khi PG down

**Contexts:** `llm-usage`, `llm-financial`

- **Đã chốt:** fail closed là chính sách đúng; reservation durable, settle/release idempotent theo quota `reservation_id` (A7, invariant 16); settlement backlog age là operational signal. **Không chấp nhận thất thoát** — settlement debt là correctness requirement, kế toán chỉ trễ, không mất ([ADR-0028](./llm-financial/adr/0028-internal-sponsorship-funding-first-party-financial-model.md) §5); attempt record + attribution ghi bền trước dispatch làm khoá capture tái dựng được sau crash (`llm-api/01-architecture.md` §13).
- **Chưa chốt:** cơ chế store bền cụ thể khi PostgreSQL down và RPO của nó; settle theo lô giữa stream để giảm cửa sổ; tiêu chí đóng cửa sổ debt (reconciliation/SLA).
- **Vì sao quan trọng:** là correctness requirement, không phải HA feature; ảnh hưởng revenue và quota.
- **Nguồn:** [`03`](../architecture/03-operations.md) §3.2b, [`01`](../architecture/01-architecture.md) §10, ADR-0028 §5.

## OB-4. Cơ chế relay outbox dùng chung

**Contexts:** mọi context phát domain event xuyên biên

- **Đã chốt:** event bất đối xứng đi qua transactional outbox nằm chung transaction với state (A8); queue chỉ là delivery channel, không phải source of truth; consumer phải idempotent. `staff-access` dùng cron Worker claim outbox + Cloudflare Queues, idempotency key = `event_id`, không NATS — [ADR-0016](./staff-access/adr/0016-outbox-relay-mechanism.md).
- **Chưa chốt:** các context khác dùng lại hình dạng này hay cần cơ chế riêng.
- **Vì sao quan trọng:** mọi event xuyên context (account→auth, payment→mail, staff-access→resource backend) phụ thuộc cơ chế này.
- **Nguồn:** [`01`](../architecture/01-architecture.md) §5, §10; ADR-0016.

## OB-5. Trigger của publisher outbox trong `push-notification`

**Contexts:** `push-notification`

- **Đã chốt:** producer notification intent; routing chỉ ở control plane; Transport và Provider là hai trục; publisher **MUST** chạy định kỳ để claim record outbox đến hạn và entry point publish là route nội bộ của control plane.
- **Chưa chốt:** **cơ chế trigger** cụ thể của publisher (cron trigger, relay ngoài, cơ chế khác) và thuộc tính "không invocation nào bị tính phí khi không có gì để publish" chưa được chứng minh cho cơ chế nào.
- **Vì sao quan trọng:** quyết định chi phí vận hành và SLA recovery của outbox; không được giả định một trigger đã tồn tại.
- **Nguồn:** [`domains/push-notification/domain-model.md`](./push-notification/domain-model.md) phần publisher/outbox.

## OB-6. Mapping `account` với `payment` và các context LLM còn lại

**Contexts:** `account`, `payment`, các `llm-*`

- **Đã chốt:** Seller đã chốt (`account` → `llm-seller-tenant`), Consumer tenant đã chốt (`account` → `llm-consumer-tenant`).
- **Chưa chốt:** mapping `account` ↔ `payment` (payout recipient?) và mapping `account` ↔ các context LLM còn lại (workspace ↔ account?).
- **Vì sao quan trọng:** tránh "lấp đầy" bằng giả định. Khi tài liệu xuất hiện, cập nhật `context-map.md` và mục này cùng lúc.
- **Nguồn:** [`architecture/01-architecture.md`](../architecture/01-architecture.md) §2, §4.

## OB-7. Provider cost — ownership và source

**Contexts:** `llm-seller-pricing`, `llm-financial`

- **Đã chốt:** customer price là giá seller cấu hình cho offer; provider cost là đại lượng kinh tế **độc lập**, không dùng để suy ra customer price. Customer charge và seller payable thuộc `llm-financial` (ADR-0003).
- **Chưa chốt:** context sở hữu provider cost; nguồn dữ liệu (bảng giá provider, invoice, hợp đồng); cách tính (list price, giá đàm phán, quy đổi FX); currency; quan hệ giữa provider cost và seller payable. Ownership **chưa được gán** cho bất kỳ context nào, kể cả sau khi tách `llm-seller`.
- **Vì sao quan trọng:** margin và đối soát với provider invoice phụ thuộc đại lượng này; gán sai owner sẽ khiến một context đọc dữ liệu của context khác. Pricing implementation chỉ được tham chiếu ranh giới này, **không** được coi provider cost là input của price resolution.
- **Nguồn:** [`llm-seller-pricing/domain-model.md`](./llm-seller-pricing/domain-model.md), [`llm-financial/domain-model.md`](./llm-financial/domain-model.md), [`llm-financial/adr/0003`](./llm-financial/adr/0003-financial-ownership.md).

## OB-8. Pricing granularity — per-offer hay per normalized model

**Contexts:** `llm-seller-pricing`, `llm-marketplace`

- **Đã chốt:** customer price thuộc seller; per-request và per-token đều bắt buộc; pricing snapshot bất biến.
- **Chưa chốt:** pricing granularity áp theo từng offer hay dùng chung theo normalized model.
- **Vì sao quan trọng:** quyết định lifecycle của pricing schedule khi offer thay đổi và cách so sánh giá giữa các seller.
- **Nguồn:** [`llm-seller-pricing/domain-model.md`](./llm-seller-pricing/domain-model.md).

## OB-9. Quyết định mở trong phạm vi một context

Các mục còn mở thuộc phạm vi **một** context — thẩm quyền reviewer, chính sách restriction/appeal, retention evidence, permission catalog, vòng đời pháp lý, tham số retention của push/mail — nằm ở phần open của `domain-model.md` của context tương ứng, không vào tài liệu này.

Tài liệu này chỉ giữ ranh giới **xuyên context** của LLM product và các boundary liên quan trực tiếp. Quyết định đã chốt bởi [ADR-0018](./llm-seller-governance/adr/0018-seller-bounded-context-split.md) và [ADR-0019](./llm-consumer-tenant/adr/0019-llm-scope-ownership-and-dependency-matrix.md) không nằm ở đây vì chúng có ADR canonical.

## 10. Quy tắc cập nhật

1. Một mục chỉ vào đây khi thật sự chưa có đáp án và công việc phụ thuộc vào nó.
2. Mỗi mục nêu rõ: câu hỏi, context liên quan, đã chốt gì, chưa chốt gì, vì sao quan trọng, nguồn.
3. Khi có ADR chốt một mục: chuyển nội dung sang tài liệu canonical, xoá mục này, để lại nhiều nhất một dòng `đã chốt → <link>`.
4. Không đưa technical implementation uncertainty, deployment blocker hay runbook issue vào đây.
