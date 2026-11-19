# Infrastructure State Backend

> **Mô tả một dòng:** introduce product **Infrastructure State** — managed, multi-tenant state backend cho infrastructure-as-code (IaC) tools: storage, versioning, concurrency locking và recovery, với core domain tool-independent, adapter layer tách bạch, Pulumi là adapter đầu tiên qua S3-compatible DIY backend surface.
>
> Tài liệu này là đặc tả **design-ahead, không phải baseline** ([`./README.md`](./README.md) §1). Không status field, không marker M1/M2, không progress, không danh sách Issue/PR; dấu kết thúc duy nhất là **một dòng terminal marker** (supersession/withdrawal), chỉ thêm khi impact class là Superseded hoặc Withdrawn. Quy tắc viết → [`./README.md`](./README.md).

## 1. Problem

Baseline hiện tại không có capability quản lý state của IaC tools. Team khách hàng vận hành IaC (Pulumi trước hết) phải tự chọn giữa:

- **DIY backend tự vận hành** (`s3://`, `postgres://`, `file://` — chính platform Ecoma cũng dùng pattern này cho deploy tooling): khách hàng giữ storage credential, secrets provider dùng passphrase client-side — mất passphrase là mất secrets vĩnh viễn (`architecture/04-platform-facts.md` PU3/PU5); locking là file-object write-then-recheck, không TTL, không atomic (Pulumi `pkg/backend/diy/lock.go`); không central audit, không authorization tập trung, không recovery có tổ chức.
- **Pulumi Cloud (SaaS bên thứ ba)**: chi phí, data residency, không lồng vào tenant/account model của Ecoma.

Portfolio Ecoma đã có product cho contract testing (pact-broker) và build state (remote-cache) nhưng không có product nào sở hữu domain knowledge về state storage có versioning và locking. Không bounded context nào hiện sở hữu tri thức này; xây lẻ trong một product khác sẽ sai boundary.

## 2. Outcome

Sau khi thay đổi được hiện thực và canonical promotion hoàn tất:

- Khách hàng (giữ nguyên workstation, CI/CD, Pulumi CLI/SDK và execution environment của mình) trỏ tool của họ vào một state backend do Ecoma vận hành: **Tenant → Project → StateResource → StateRevision** với isolation, authorization, audit tập trung.
- State được **version hoá**: mỗi lần ghi tạo một revision mới, chuỗi append-only, phục vụ rollback/recovery mà không xoá history.
- **Concurrency locking** với lease và fencing: hai writer đồng thời không thể ghi đè lẫn nhau; writer stale (crash rồi quay lại, hoặc bị force-unlock) không ghi đè được state mới hơn — trong phạm vi enforce được qua surface của từng adapter (§5.2/§5.3).
- **Credential** dạng machine token, project-scoped, theo discipline chung của Ecoma (hash-only, show-once, revoke-only).
- **Adapter layer** tách bạch core domain khỏi protocol của từng tool; Pulumi là adapter đầu tiên qua S3-compatible DIY backend surface (documented, stable).
- Management UI + control plane cho tenant/project/resource/credential/audit, theo BFF skeleton chung.

Non-goals, chốt rõ: **không** runner hosting; **không** CI/CD orchestration; **không** infrastructure provisioning; **không** provider/runtime management; **không** deployment execution; **không** GitOps orchestration. Product không trở thành platform chạy IaC — khách hàng tự chạy tool, product chỉ giữ state.

## 3. Baseline references

| Nguồn baseline                                                              | Phần liên quan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/architecture/01-architecture.md`                                      | A1 (edge-first Workers), A2 (PG từ ngày đầu, một DB + role per owner), A5 (Hyperdrive/VPC/Tunnel), A8 (outbox + idempotency cho event), A9 (một storage resource = một owning service), A16 (rollback Worker-only, expand→contract), A20 (DB theo bounded context); invariant 5 (per-DB grants), 6 (**authoritative state chỉ ở PostgreSQL hoặc D1**), 7 (không cross-service DB), 12 (không node-local correctness state), 18 (per-Worker rollback); A22–A24 (scope ≠ permission, deny-by-default, revocation latency) |
| `docs/architecture/04-platform-facts.md`                                    | PU3/PU5/PU10 (DIY backend + passphrase secrets), R21/R22 (R2 S3-compatible path-style, Bucket Locks GA), DB2/DB4 (D1 hạn chế — lý do chọn PG), Hyperdrive reachability                                                                                                                                                                                                                                                                                                                                                  |
| `docs/domains/remote-cache/`                                                | ADR-0015 (shared infra → SaaS bounded context); pattern: tool-native protocol + Ecoma auth cùng tồn tại; PG authoritative + object storage blobs non-authoritative; project là isolation unit; quota/retention/audit                                                                                                                                                                                                                                                                                                    |
| `docs/domains/pact-broker/adr/`                                             | ADR-0031 (dual-path auth theo token shape), ADR-0032 (machine credential product-owned)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/domains/staff-access/adr/0020-bootstrap-seed-contract.md`             | ADR-0020 — ops bootstrap tenant, fail-closed, refuse resurrection                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/domains/llm-consumer-tenant/adr/`                                     | ADR-0025 (tenant kernel là closed primitive list — không mở kernel cho role/permission/lifecycle/quota/credential)                                                                                                                                                                                                                                                                                                                                                                                                      |
| `docs/domains/account/domain-model.md`, `docs/domains/auth/domain-model.md` | `sub` opaque reference (không FK cross-DB), session/consent/access token; account không sở hữu tenant/membership/API credential — product-owned                                                                                                                                                                                                                                                                                                                                                                         |
| `libs/staff-access-contracts/`, `docs/domains/staff-access/adr/`            | entitlement = "nhân sự X có được dùng sản phẩm P", event qua Queue (pattern pact-broker entitlement-consumer)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `libs/tenant-kernel-domain/`                                                | P1–P5 primitives dùng lại nguyên trạng, không mở rộng                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `docs/architecture/06-testing.md`                                           | `test` / `test-integration` / `system-test`, layout `apps/<app>/tests/`, `system-tests/`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `docs/engineering/work-management.md` §4.1                                  | Product Registry — dòng `infrastructure-state` được thêm trong cùng logical change với spec này                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 4. Affected scope

| Mục                                                                                                          | Change type | Loại đối tượng                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------- |
| `infrastructure-state` (bounded context: tenant, project, state resource, revision, lock, credential, audit) | `introduce` | bounded context                                                                         |
| `infrastructure-state-api` — Worker, serve adapter surface S3-compatible và control plane                    | `introduce` | application                                                                             |
| `infrastructure-state-app` (Nuxt BFF + management UI)                                                        | `introduce` | application                                                                             |
| Adapter endpoint contract (S3-compatible surface mà Pulumi DIY backend tiêu thụ)                             | `introduce` | contract (product-owned)                                                                |
| Product Registry trong `docs/engineering/work-management.md` §4.1 (dòng `infrastructure-state`)              | `evolve`    | architecture area (canonical edit, đã thực hiện trong cùng logical change với spec này) |

## 5. Target model

### 5.1 Core domain (tool-independent)

Một bounded context duy nhất `infrastructure-state` sở hữu toàn bộ tri thức dưới đây. Không khái niệm Pulumi/Terraform nào nằm ở tầng này.

**Concepts và phân biệt identity:**

- **Tenant** — product-owned, không dùng chung với product khác và không nằm trong account/auth (A25/ADR-0025 — không có shared Tenant context; A26/ADR-0026 — `first_party|customer` + `plan`; precedent `remote_cache.tenants` / `pact.tenants`: `id`, `name` unique, `status`, `owner_sub` là `sub` opaque reference — không FK cross-DB; `classification first_party|customer` + `plan` theo shape chung). Tenant không có khái niệm "organization" của tool nào.
- **Project** — isolation unit cho credential và state resource (precedent remote-cache project): mỗi credential gắn đúng một project; không có tenant-level key.
- **StateResource** — identity là `(project, name)`; `name` immutable sau tạo; status `active | archived`; xoá là tombstone (archived), không xoá vật lý chuỗi revision.
- **StateRevision** — một revision = một bản state tại một thời điểm của một resource. Revision là **append-only, immutable**, sequence monotonic per resource; nội dung blob content-addressed (hash) trong object storage, metadata row ở PostgreSQL. State identity ≠ revision identity: một resource có nhiều revision; revision identity ≠ lock identity: lock không phải revision.
- **Lock** — exclusive per StateResource; thuộc tính: holder (= credential id), `acquired_at`, `lease_expires_at` (renew được), **fencing token tăng đơn điệu per resource**. Lock identity độc lập với cả resource lẫn revision.
- **Credential** — machine token product-owned (precedent ADR-0032 + remote-cache API key): project-scoped, scopes `read | write`, SHA-256 hash-only DB, plaintext show-once, revoke-only, không `last_used_at`.
- **AuditEvent** — append-only (pattern `pact.audit_events`), không plaintext token, không body state.

**Lifecycle (StateResource):** `create → active → (write revisions while locked) → archived (tombstone)`. Archived resource không nhận lock mới, không nhận revision mới; unarchive là policy mở (§9 OD-4).

**Concurrency model — invariants:**

- **I1 (append-only):** revision đã accept không bao giờ bị sửa hay xoá theo thứ tự chuỗi; mọi ghi mới tạo revision mới.
- **I2 (CAS):** ghi mới chỉ accept khi: credential có scope `write` trên project + lock còn hiệu lực (lease chưa hết) trên resource + `expected_base_revision` trỏ đúng head hiện tại. Mọi điều kiện sai → 409, không ghi.
- **I3 (fencing + renew):** renew chỉ thành công khi lease chưa hết hạn, caller đúng holder và fencing token khớp — hết hạn thì đường duy nhất là re-acquire (bump token); force-release (admin unlock, audited) cũng bump token; writer stale trình lái guard token cũ bị từ chối dù nó còn nghĩ mình đang giữ lock. **Lease hết hạn không chứng minh writer cũ đã dừng — hệ thống không bao giờ dùng hết hạn làm đủ điều kiện ghi đè.** Cả renew lẫn re-acquire hiện thực bằng một UPDATE có điều kiện trên hàng lock (khớp holder + token trước khi hết hạn → gia hạn; không khớp → từ chối), đóng race giữa renew của holder cũ và acquire của holder mới.
- **I4 (authority):** PostgreSQL là sole authority (invariant 6): metadata resource/revision/lock/credential/audit ở PG; object storage chỉ giữ blob content-addressed, idempotent theo hash, orphan được GC. GC chỉ xoá blob chưa được tham chiếu và đã tồn tại quá grace period lớn hơn khoảng upload-blob → commit-row tối đa (hoặc xoá hai pha: mark một pass, sweep ở pass sau) — không xoá đè lên write đang in-flight; mất blob orphan không mất tính đúng đắn của chuỗi revision.
- **I5 (audit):** mọi mutation của tenant/project/resource/credential/lock/unlock tạo audit event trong cùng transaction.

**Recovery model:** rollback = tạo revision mới có nội dung trỏ về revision cũ (không xoá history); stale-lock handling: lease hết hạn → writer mới re-acquire được; admin force-unlock là operation có audit và bump fencing token; interrupted write (blob ghi mà revision row chưa commit) ⇒ revision chưa tồn tại, blob orphan, state an toàn.

### 5.2 Adapter layer

- **Core contract** là tập operation tool-agnostic (read/write state, list revisions, acquire/renew/release lock) do product sở hữu, định nghĩa bằng domain terms — không leak protocol của tool nào vào core.
- **Surface-only operations:** ngoài core contract, adapter được phép expose các operation surface-only không có nghĩa domain (ví dụ qua DIY surface: `history/`, `backups/`, auxiliary objects — Put/Get/Delete/List trên keys trong namespace của project, nội dung opaque). Tập operation này được liệt kê tường minh trong adapter contract của từng adapter và không được dùng để mang semantics của tool vào core.
- **Adapter** là module trong `infrastructure-state-api`, map protocol của một tool lên core contract. Adapter chỉ được dùng guarantee mà surface của tool cho phép; phần guarantee không map được phải được ghi tường minh per-adapter (ví dụ locking client-managed của Pulumi DIY — §5.3).
- **Adapters được đánh giá độc lập** — bằng chứng: Terraform có officially documented HTTP backend (GET/POST/DELETE + LOCK/UNLOCK, `developer.hashicorp.com/terraform/language/backend/http`), Ansible không có khái niệm native state backend (chỉ inventory + fact cache), Pulumi DIY là object/blob surface. Không assume chung semantics.
- Không đưa Pulumi Stack trở thành entity của core: mapping `{organization, project, stack}` (Pulumi) → `{tenant, project, state resource}` (core) là responsibility của Pulumi adapter.

### 5.3 Pulumi adapter (adapter đầu tiên)

**Surface chọn: DIY S3-compatible backend** — documented, stable, in-tree (`pkg/backend/diy/`): khách hàng `pulumi login 's3://<bucket>?endpoint=<ecoma-endpoint>&s3ForcePathStyle=true'`; CLI tự quản layout `.pulumi/` (`stacks/`, `locks/`, `history/`, `backups/`) như opaque bytes. Ecoma endpoint hiện thực: SigV4, subset `ListBucket/GetObject/PutObject/DeleteObject`, strong read-after-write, checksum headers khoan dung (incident R2 `InvalidDigest` ở CLI 3.256.0 đã fix — surface có thể vỡ do SDK defaults, xem §7 Assumption A).

**Credential model:** khách hàng không giữ storage credential của Ecoma — endpoint là hiện thực của Ecoma, xác thực bằng Ecoma-issued credential (machine token theo §5.1). Attribution key → project là **theo credential**: mỗi credential bind đúng một project, mọi object key trong request được attribute về project đó và enforce scoping + audit + quota server-side per request (không suy project từ layout). Đây là điểm khác biệt có chủ đích so với DIY backend tự vận hành (nơi khách hàng giữ thẳng AWS/GCS credential).

**Loại trừ có bằng chứng — cloud-API emulation NO-GO:** `pulumi login https://…` biến URL thành Pulumi Cloud backend với REST surface undocumented-as-contract (`Accept: application/vnd.pulumi+8/9`, closed-source server, churn `pkg/backend/httpstate` 3–36 commits/tháng 2026-06→11 — đo bằng GitHub API, nghiên cứu 2026-11-19; mọi reimplementation bên third-party sống bằng version-pinning, pulumi/pulumi#4727 mở từ 2020 không có official intent). Wire capture với CLI v3.267.0 (2026-11-19, record trên issue #429): login gọi thẳng `/api/user` → `/api/capabilities` → `/api/stacks/…`, không có extension point. Không hiện thực hoá route này cho tới khi Pulumi có official extension point.

**Limitation phải ghi tường minh:** DIY locking là client-managed — write-then-recheck lock object, không TTL, recovery bằng xoá lock object (`pulumi cancel`). Core guarantee I3 chỉ enforce được một phần qua surface này; phần nào enforce được server-side là open decision kèm experiment (§9 OD-1).

**Secrets:** state bên trong được CLI encrypt client-side (passphrase/KMS secrets provider) — backend không bao giờ thấy key; mất passphrase của khách hàng vẫn mất khả năng decrypt dù Ecoma giữ đủ history (PU3/PU5 là rủi ro của khách hàng, ghi rõ trong onboarding/requirement).

### 5.4 Applications

- **`infrastructure-state-api`** — Worker (Hono, edge-first A1): serve (a) S3-compatible adapter endpoint cho Pulumi CLI, (b) control plane API cho management; PG qua Hyperdrive (A5); blob storage qua port S3-compatible (pattern `remote-cache-api/src/storage.ts`: SeaweedFS local, R2 production — R21); entitlement consumer qua Queue (pattern pact-broker) cho staff-access; một DB `db-infrastructure-state` (A2/A20), schema `infra_state`.
- **`infrastructure-state-app`** — Nuxt SPA (`ssr:false`) + Nitro BFF (`cloudflare-module`), skeleton chung (session table trong DB riêng `db-infrastructure-state-app`, token không xuống browser, `run_worker_first`) theo precedent pact-broker-app.

## 6. Dependencies

Không phụ thuộc Change Specification nào — đây là spec đầu tiên của repository; đồ thị dependency (hiện chỉ có spec này) acyclic.

Shared context/library tiêu thụ, không yêu cầu thay đổi:

- `tenant-kernel-domain` — primitives P1–P5 dùng nguyên trạng (không mở rộng — ADR-0025).
- `staff-access-contracts` + entitlement flow — product-level "nhân sự X có được dùng Infrastructure State", event qua Queue (outbox→Queue relay shape đang là câu hỏi mở dùng chung OB-4 trong `docs/domains/open-boundaries.md` — product theo pattern hiện hành của pact-broker, không chốt OB-4 hộ).
- `auth` — OIDC/JWKS cho human path; `account` — `sub` opaque reference.

Pipeline bị ảnh hưởng: Product ID `infrastructure-state`; chưa có Milestone committed nào đang lái product này (chưa có khai báo `Horizon:` nào trỏ tới).

## 7. Assumptions

- **A — DIY S3 surface ổn định ngắn hạn.** Đứng trên: surface documented + Pulumi đầu tư in-tree (PostgreSQL backend merge 2025 — pulumi/pulumi#19581). Điều kiện sai: một SDK-default change kiểu R2 `InvalidDigest` (CLI 3.256.0, pulumi/pulumi#24109 → fix #24219, 2026-07 — nguồn nghiên cứu 2026-11-19, chưa verify trực tiếp; trải nghiệm tương tự đã có trong repo qua R2 Pulumi backend của staging) hoặc Pulumi deprecate DIY. Hệ quả: adapter phải update — spec vào Rebase nếu contract shape đổi; journey #430 pin version để đo surface stability.
- **B — PG đủ cho lock authority ở quy mô mong đợi.** State write là deploy-frequency, không phải artifact-cache-frequency. Điều kiện sai: contention hoặc TPS vượt khả năng row-lock PG trên lock table — khi đó mới cân nhắc engine khác và phải có ADR + consistency analysis (không thêm Redis chỉ vì quen).
- **C — Wire capture của spike đại diện cho 3.x hiện hành.** Spike đã xác nhận login + stack-init endpoint family trên CLI v3.267.0; state read/write/locking qua S3 surface chưa được wire-verify (OD-7). Điều kiện sai: behavior CLI khác giữa versions — experiment phải pin version.
- **D — Khách hàng chấp nhận passphrase secrets model** (như Pulumi Cloud — cũng client-side encrypt). Điều kiện sai: product cần server-side secrets provider — mở spec mới, không kéo vào spec này.

## 8. Compatibility & impact

- Greenfield: không consumer hiện hữu, không breaking change, không đụng contract đang chạy.
- Baseline canonical chỉ đụng hai edit đã nằm trong cùng logical change với spec này: dòng Product Registry (`work-management.md` §4.1) và dòng index (`changes/README.md` §6). Không canonical doc nào khác mô tả target này.
- Shared kernel không mở rộng; không tenant mới trong catalog Domains cho tới canonical promotion (§5 catalog rule — pending introduce chỉ index tại `changes/`).
- Khi delivery: schema/contract tuân theo expand → compatible rollout → contract từ migration đầu tiên; migration contract chung (per-service DB, migrator/runtime roles, apply ngoài Hyperdrive).
- Milestones M2/M3/M4/M5 hiện committed không tham chiếu product này — không interference với M2 delivery.

## 9. Decisions

**Accepted target decisions** (chốt trong phạm vi target của spec — chỉ ràng buộc spec này và delivery unit khai báo phụ thuộc; không là baseline cho tới canonical promotion; nơi chốt của tất cả các mục dưới đây là PR merge của spec này — #433):

- **ATD-1** — Một bounded context `infrastructure-state` sở hữu toàn bộ domain knowledge: tenant, project, state resource, revision, lock, credential, audit.
- **ATD-2** — PostgreSQL là sole authority; object storage chỉ giữ blob content-addressed non-authoritative (invariant 6; precedent remote-cache).
- **ATD-3** — Locking dùng PG lease + fencing token + CAS precondition; không đưa Redis vào làm lock authority (không có documented reason + consistency analysis nào đòi hỏi).
- **ATD-4** — Reuse house patterns nguyên trạng: credential discipline (SHA-256 hash-only, show-once, revoke-only), BFF skeleton, migration contract, ADR-0020-style ops bootstrap cho tenant canonical, staff-access entitlement cho product access.
- **ATD-5** — Adapter layer nằm trong `infrastructure-state-api` (module, không deploy unit riêng); adapter contract là internal contract của product.
- **ATD-6** — Pulumi adapter đi qua S3-compatible DIY backend surface; cloud-API emulation bị loại (§5.3).
- **ATD-7** — Naming: Product ID `infrastructure-state`; apps `infrastructure-state-api` / `infrastructure-state-app`; DB `db-infrastructure-state` + `db-infrastructure-state-app`; PG schema `infra_state`.
- **ATD-8** — Product Registry thêm dòng `infrastructure-state` (đã ghi trong cùng logical change với spec này — edit canonical cục bộ, không phải ADR theo `AGENTS.md` §10).

**Open decisions** (mỗi item: câu hỏi — bằng chứng hiện có — hướng — rủi ro — việc tiếp theo):

- **OD-1 — Server-side lock enforcement qua S3 surface.** Câu hỏi: endpoint có nên tự từ chối write vào `stacks/` khi lock object do nó quản đã hết lease (409) không, hay để CLI tự quản y như DIY thuần? Bằng chứng: DIY locking là client-managed, write-then-recheck, không TTL (`pkg/backend/diy/lock.go`); hành vi CLI khi nhận 409 trên lock/state write chưa wire-verified. Hướng: enforce trước, fallback thuần DIY nếu CLI hỏng giao thức. Rủi ro: breaking CLI flows chưa đoán hết. Việc tiếp: experiment — chạy real CLI qua endpoint fake bắt mọi response, đo hành vi khi lock write bị từ chối (pin version).
- **OD-2 — State blob encryption.** Câu hỏi: at-rest encryption nào — platform PG/storage mặc định, hay app-layer envelope encryption per project? Bằng chứng: chưa có platform fact về encryption at-rest mặc định của storage tier; secrets bên trong state đã client-encrypted. Rủi ro: chốt sai trước khi có platform fact. Việc tiếp: verify platform fact (`04-platform-facts.md`) trước schema production; quyết định theo `AGENTS.md` §11.
- **OD-3 — Retention/backup/restore policy.** Câu hỏi: retention per revision bao lâu, backup cadence, restore SLA, quota mặc định? Bằng chứng: chưa có yêu cầu khách hàng cụ thể. Việc tiếp: requirement discovery trước M1 của product.
- **OD-4 — Permission vocabulary chi tiết.** Câu hỏi: role ladder (admin/member/viewer kiểu pact, hay member duy nhất + scopes kiểu remote-cache?) và unarchive policy. Bằng chứng: hai product đang dùng hai vocabulary khác nhau (ADR-0015: never merged). Việc tiếp: ADR lúc delivery-slice đầu có UI.
- **OD-5 — Human control-plane auth channel.** Câu hỏi: forward user JWT tới api (pact) hay HMAC envelope (remote-cache)? Bằng chứng: hai pattern cùng tồn tại trong portfolio. Việc tiếp: ADR lúc delivery BFF.
- **OD-6 — Quota/rate-limit semantics cho state write.** Câu hỏi: fatal (429 chặn write) hay non-fatal (cache-miss semantics của remote-cache không áp dụng được — state write thất bại phải fatal cho deploy)? Bằng chứng: hai precedent khác nhau. Hướng mặc định: fatal. Việc tiếp: chốt cùng OD-3.
- **OD-7 — Wire-level verification của state operations.** Câu hỏi: toàn bộ journey `login → stack create/select → state read/write → concurrent ops → interrupted op → stale-lock recovery → revision consistency` qua S3 surface hoạt động thế nào trên real CLI? Bằng chứng: spike hiện có chỉ cover login + stack-init endpoint family. Việc tiếp: experiment issue riêng, pin CLI version, kết luận gắn vào OD-1 và adapter contract cuối.

## 10. Acceptance & promotion criteria

**Accept của spec** = merge vào default branch (design input — `changes/README.md` §1). Delivery một phần không promotion; quyết định hiện hành nếu đổi baseline đang chạy phải ghi canonical ngay theo `changes/README.md` §3.

**Điều kiện đạt của target (khi delivery):**

- **Core-contract invariant tests** (integration layer, `apps/infrastructure-state-api/tests/`, target `test-integration`): **I1** — append-only: mọi attempt sửa/xoá revision đã commit bị từ chối ở storage/metadata layer; **I2** — CAS: write với `expected_base_revision` lệch bị 409, không tạo revision; **I3** — renew/expired-lease và stale-fencing bị từ chối; force-release bump token; **I4** — GC không xoá blob được tham chiếu và không đè write in-flight (grace period); **I5** — mutation không có audit event cùng transaction bị rollback (atomicity).
- **Real-CLI journey tests** (system layer, `system-tests/`, theo `architecture/06-testing.md`): login vào endpoint, stack create/select, state read/write, hai writer đồng thời, interrupted op, stale-lock recovery (admin unlock), revision consistency. Bước stale-lock/409 có expected outcome **phụ thuộc resolution của OD-1** (DIY thuần: write kế tiếp của CLI stale thành công; enforce server-side: bị từ chối) — test viết sau khi OD-1 chốt trên #430.
- Mọi guarantee không map được qua surface (DIY locking client-managed) được ghi trong adapter contract của `infrastructure-state-api`, không nằm trong domain model.

**Canonical promotion — checklist riêng của spec này** (atomic, một logical change):

- Cập nhật: `docs/domains/README.md` catalog + `docs/domains/context-map.md` (context `infrastructure-state`); `docs/applications/README.md` + hai component docs (`infrastructure-state-api`, `infrastructure-state-app`); `docs/features/` chỉ khi capability đã có implementation evidence — cấm Feature target-only.
- Viết ADR theo `AGENTS.md` §10 tại `docs/domains/infrastructure-state/adr/`: (1) data ownership + storage split PG/object storage + DB/schema naming (ATD-2, ATD-7), (2) locking/lease/fencing (ATD-3), (3) Pulumi backend compatibility (ATD-6), (4) tenant/credential authorization reuse, (5) adapter extensibility (ATD-5).
- Retire spec file + index line theo `AGENTS.md` §6 và `changes/README.md` §4.
