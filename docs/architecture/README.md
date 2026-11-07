# Architecture

Nguyên tắc và cấu trúc kiến trúc chung của toàn hệ thống Ecoma — trả lời câu hỏi: **toàn hệ thống được tổ chức như thế nào và phải tuân thủ quy tắc gì?** Trục này nói về hệ thống như một tổng thể; trách nhiệm nghiệp vụ của từng bounded context → [`docs/domains/`](../domains/README.md); executable component hiện thực → [`docs/applications/`](../applications/README.md).

| Document                                               | Nội dung                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`01-architecture.md`](./01-architecture.md)           | System topology, deploy unit, data ownership, cross-service communication, security boundary, hostname/routing, architectural decisions (A1–A24) và system invariants (1–36); ADR per-context nằm trong `docs/domains/<context>/adr/` |
| [`02-delivery.md`](./02-delivery.md)                   | Git, Nx, CI/CD, contracts delivery, migration, environments, release và rollout                                                                                                                                                       |
| [`03-operations.md`](./03-operations.md)               | Deployment operations, observability, failure handling, backup/DR, recovery, operational policies                                                                                                                                     |
| [`04-platform-facts.md`](./04-platform-facts.md)       | Verified external platform facts (Cloudflare, PostgreSQL, …) — có nguồn và ngày xác minh                                                                                                                                              |
| [`05-code-architecture.md`](./05-code-architecture.md) | Nx project structure, bounded context ↔ scope, DDD layers, dependency rules, contracts                                                                                                                                                |
| [`06-testing.md`](./06-testing.md)                     | Testing architecture — taxonomy, ownership/layout, Nx target contracts, test environment                                                                                                                                              |
| [`local-development/`](./local-development/README.md)  | Local development platform — shared Docker network, Traefik, PostgreSQL, worktree isolation, Pulumi local backend, local TLS, account/auth topology, operations và evidence                                                           |

## Bốn view tri thức

Bảng bốn view (`architecture/` · `domains/` · `applications/` · `features/`) và canonical location của từng loại nội dung → [`docs/README.md`](../README.md) và [`docs/AGENTS.md`](../AGENTS.md) §4. Thư mục này là view **Architecture**; bốn view là bốn góc nhìn khác nhau, không phải bốn bản mô tả lặp lại cùng một hệ thống.

Architecture sở hữu system topology, ranh giới deploy/service, data ownership cấp hệ thống, cross-service communication, security boundary, system invariants, hạ tầng và database hosting, delivery/deployment/release/backup/DR, Nx/code architecture và local development platform. Architecture **không** sở hữu domain model của một bounded context hay thiết kế nội bộ của một Application.

`local-development/` là hạ tầng phục vụ **mọi** component: nó thuộc Architecture, không phải một Application và không phải một bounded context.
