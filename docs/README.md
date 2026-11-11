# Ecoma.io Documentation

> Tài liệu phản ánh thiết kế và kỳ vọng phát triển của hệ thống, **không** phải trạng thái hiện tại. Không mặc định mọi thành phần được mô tả đã tồn tại.

## Bốn view tri thức

Repository là nguồn canonical của tri thức kỹ thuật, tổ chức thành bốn view. Mỗi view trả lời một câu hỏi khác nhau; chúng không phải bốn bản mô tả lặp lại cùng một hệ thống.

| View             | Trả lời                                                              | Index                                                |
| ---------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| **Architecture** | Hệ thống tổ chức ra sao, phải tuân thủ ràng buộc gì                  | [`architecture/README.md`](./architecture/README.md) |
| **Domains**      | Nghiệp vụ vận hành theo quy tắc nào, context nào sở hữu tri thức nào | [`domains/README.md`](./domains/README.md)           |
| **Applications** | Thành phần phần mềm nào hiện thực điều đó, bằng cách nào             | [`applications/README.md`](./applications/README.md) |
| **Features**     | Người dùng nhận được capability gì và verify bằng gì                 | [`features/README.md`](./features/README.md)         |

Ánh xạ vị trí canonical:

- [`architecture/`](./architecture/README.md) — topology, ranh giới deploy, data ownership cấp hệ thống, communication, security boundary, system invariants, hạ tầng, delivery, Nx/code architecture, và local development platform ([`architecture/local-development/`](./architecture/local-development/README.md)).
- [`domains/`](./domains/README.md) — business knowledge: [`glossary.md`](./domains/glossary.md), [`context-map.md`](./domains/context-map.md), [`open-boundaries.md`](./domains/open-boundaries.md), catalog bounded context, và `domain-model.md` của từng context.
- [`applications/`](./applications/README.md) — executable component và composition: UI/BFF, API service, control plane, data plane, background worker, maintenance job. Background job nằm phẳng cạnh API/BFF, không có thư mục con `jobs/`.
- [`features/`](./features/README.md) — Feature document: vấn đề người dùng, outcome, phạm vi, acceptance scenario, domain/application tham gia và test verify.
- [`changes/`](./changes/README.md) — Change Specification: đặc tả future target cho một thay đổi introduce/evolve/retire, kèm hai promotion (horizon promotion, canonical promotion) và impact classes — design-ahead, **không** phải baseline.

Ranh giới canonical đầy đủ → [`AGENTS.md`](./AGENTS.md) §3–§4.

## Engineering — quá trình

[`engineering/`](./engineering/README.md) không phải view tri thức thứ năm về hệ thống. Đây là quá trình kỹ thuật đích — cách hiểu hệ thống, tiến hoá mô hình, chọn và hiện thực vertical slice, verify và reconcile:

- [Engineering Evolution Process](./engineering/evolution-process.md) — canonical: ba lớp, bốn view, năm giá trị Issue Type (Discovery · Modelling · Experiment · Delivery · Remediation), vòng đời bảy bước, bốn trạng thái năng lực (Specified · Implemented · Verified · Released), reconciliation và deviation semantics.
- [GitHub Work Management](./engineering/work-management.md) — canonical: khi nào một work item cần Issue, Issue khác ledger/precondition tracker/experiment record thế nào, Issue Type native là nguồn classification duy nhất (kèm transition), root-issue Project membership (sub-issue không thuộc Project), product pipeline `M1 → M2 → Feature Discovery` độc lập theo từng product đọc từ khai báo commitment của Milestone, Milestone delivery commitment độc lập với product (cross-product khi phối hợp một outcome; completion/activation/release độc lập), điều kiện đóng, và trách nhiệm của Project, Milestone, Pull Request; `project:track` là ràng buộc chuyển tiếp.
- [Contribution Workflow](./engineering/contribution-workflow.md) — canonical: các hành động và handoff nối vòng đời bảy bước với công việc thực tế, cách chọn validation theo scope, và ranh giới giữa hướng dẫn với ràng buộc repository.

Entry point cho contributor → [`CONTRIBUTING.md`](../CONTRIBUTING.md) ở repository root.

## Architecture — system level

1. [Architecture](./architecture/01-architecture.md) — topology, ranh giới service, data ownership, invariants.
2. [Delivery](./architecture/02-delivery.md) — Git, CI/CD, contracts, migration, môi trường, release và rollback.
3. [Operations](./architecture/03-operations.md) — backup/DR, hành vi khi sự cố, observability, alert và database hosting tier.
4. [Platform Facts](./architecture/04-platform-facts.md) — capability và giới hạn đã xác minh của nền tảng.
5. [Code Architecture](./architecture/05-code-architecture.md) — Nx project structure, Bounded Context, DDD layers, dependency rules, contracts.
6. [Testing](./architecture/06-testing.md) — testing architecture: quyền sở hữu test, layout thư mục (`apps/<app>/tests/`, `system-tests/`), ba target Nx canonical (`test`, `test-integration`, `system-test`), môi trường test.
7. [Local Development](./architecture/local-development/README.md) — hạ tầng Docker local dùng chung, worktree isolation, Pulumi local backend, local TLS, topology account/auth local, operations và evidence.

## Domains

Catalog đầy đủ → [Domains](./domains/README.md) — canonical cho catalog bounded context; ngôn ngữ dùng chung ở [`glossary.md`](./domains/glossary.md), quan hệ ngữ nghĩa ở [`context-map.md`](./domains/context-map.md), ranh giới nghiệp vụ chưa chốt ở [`open-boundaries.md`](./domains/open-boundaries.md).

Business model, rule và invariant của từng context nằm trong `domains/<context>/domain-model.md`.

## Applications

Index đầy đủ → [Applications](./applications/README.md) — composition, UI/BFF, API service, control plane, data plane, background job và maintenance job. Mỗi component có `README.md` và, khi có nội dung, `01-architecture.md` / `02-requirements.md` / `03-operations.md`.

## Ranh giới tài liệu

| Vị trí                              | Chứa                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `architecture/`                     | Quyết định và policy **của toàn hệ thống**                                                                                                                                                 |
| `architecture/local-development/`   | Hạ tầng local dùng chung và đường deploy local — **không** phải Application hay bounded context                                                                                            |
| `domains/README.md`                 | Catalog bounded context và ownership rule của Domains view                                                                                                                                 |
| `domains/glossary.md`               | Ngôn ngữ domain dùng chung, kèm context sở hữu                                                                                                                                             |
| `domains/context-map.md`            | Quan hệ ngữ nghĩa giữa bounded contexts (DDD patterns)                                                                                                                                     |
| `domains/open-boundaries.md`        | Ranh giới **nghiệp vụ** thực sự chưa chốt                                                                                                                                                  |
| `domains/<context>/domain-model.md` | Business knowledge của một bounded context: khái niệm, lifecycle, policy, invariant, domain event, quyền nghiệp vụ                                                                         |
| `domains/<context>/adr/`            | Accepted decision record của context — kể cả quyết định system-wide                                                                                                                        |
| `applications/<component>/`         | Thiết kế, requirement kỹ thuật và runbook **của một executable component**; background job nằm phẳng, không trong `jobs/`                                                                  |
| `architecture/04-platform-facts.md` | **Fact của nền tảng**, kèm nguồn · ngày · mức tin cậy                                                                                                                                      |
| `engineering/`                      | Quá trình kỹ thuật đích: ba lớp, bốn view, Issue Type, vòng đời, trạng thái năng lực và reconciliation — **không** phải tri thức về hệ thống                                               |
| `features/`                         | Vấn đề người dùng và product capability **đã có implementation** — kèm acceptance scenario, domain/application tham gia và test verify; không phải backlog                                 |
| `changes/`                          | Change Specification **future target** (introduce/evolve/retire) cùng hai promotion và impact classes — design-ahead, không phải baseline; **không** phải backlog/roadmap/status dashboard |
