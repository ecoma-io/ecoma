# Remote Cache Service — Operations

> **Policy của toàn hệ thống** (Git, CI/CD, deploy order, rollback, secrets, trust boundary) nằm ở [`docs/architecture/02-delivery.md`](../../architecture/02-delivery.md). File này chỉ mô tả **cách riêng `cache` tuân thủ** policy đó.
> Invariant kiến trúc: [`01-architecture.md`](./01-architecture.md). Tiêu chí kiểm chứng: [`02-requirements.md`](./02-requirements.md).

Service: `cache.ecoma.io` trên Cloudflare Workers, artifact trên B2. Cache artifact **disposable** — không backup, không recovery dữ liệu cache.

---

## 1. Configuration

Hai phía phải phân biệt rõ; nhầm lẫn hai bên là nguồn lỗi cấu hình thường gặp nhất.

**Phía server (Worker)** — qua environment variables hoặc Cloudflare bindings:

```text
MAX_ARTIFACT_SIZE
LOG_LEVEL
B2_ENDPOINT
B2_BUCKET
B2_APPLICATION_KEY_ID
B2_APPLICATION_KEY     ← secret
```

Credential sản xuất MUST lưu dạng secret. **Không** commit `B2_APPLICATION_KEY`, API key hay CI cache token vào repository. Khi control plane đã triển khai, storage credentials SHOULD do control plane quản lý thay vì hard-code trong data-plane deployment.

**Phía client (Nx)** — hai biến bắt buộc, xem §4.

---

## 2. Environments

`cache` là một trong các Worker theo môi trường của hệ thống:

| Môi trường | Endpoint                    | Credential                                                                    |
| ---------- | --------------------------- | ----------------------------------------------------------------------------- |
| Local dev  | dùng chung `cache.ecoma.io` | developer key, project-scoped                                                 |
| PR         | dùng chung `cache.ecoma.io` | **không** có write credential (`docs/architecture/02-delivery.md` §6 rule 10) |
| Staging    | Worker `stg-*`              | CI key của staging                                                            |
| Production | Worker production           | CI key production                                                             |

Preview chạy theo chính sách Worker Preview chung (`docs/architecture/02-delivery.md` §5) — không tạo Worker identity riêng.

---

## 3. Deployment

Theo làn Workers và policy version/rollback của [`docs/architecture/02-delivery.md`](../../architecture/02-delivery.md) §7–§8. Việc của `cache`:

- Sau mỗi deploy production chạy verification §5 — không coi deployment thành công chỉ vì Worker đã deploy.
- **Không purge cache artifacts khi deploy hay rollback `cache`** — rollback code không đồng nghĩa rollback dữ liệu (`docs/architecture/02-delivery.md` §8).
- Không sửa trực tiếp production configuration để xử lý lỗi application khi thay đổi đó có thể đưa vào source-controlled configuration.

---

## 4. CI

**Bật remote cache** — hai biến bắt buộc, đặt `NX_SELF_HOSTED_REMOTE_CACHE_SERVER` là **thay** điểm remote cache, không cộng thêm lên Nx Cloud:

```bash
NX_SELF_HOSTED_REMOTE_CACHE_SERVER=https://cache.ecoma.io
NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=<project-scoped-key>
```

Developer key MUST **không** dùng trong CI; CI key MUST nằm trong secret store của CI provider và phải là **write** key.

**Phân quyền credential:**

| Consumer            | Write | Nguồn credential              |
| ------------------- | :---: | ----------------------------- |
| Trusted CI (`main`) |  ✅   | GitHub Environment production |
| PR nội bộ           |  ❌   | read-only key, hoặc không có  |
| Fork PR             |  ❌   | không có credential nào       |

PR/fork có **không** có write credential tới shared cache là invariant, không phải tuỳ chọn.

**Fallback khi cache unavailable:**

```bash
NX_DISABLE_REMOTE_CACHE=true   # hoặc NX_SKIP_REMOTE_CACHE
```

Đây là cơ chế Nx có sẵn. Bật khi cần — task phải chạy lại được, không mất correctness.

**Test compatibility trong CI (bắt buộc, `docs/architecture/02-delivery.md` §10):** GET/PUT cache artifact · authentication · immutable existing entry / `409` · local → CI cache hit.

---

## 5. Verification

Sau **mỗi** lần deploy production. Không coi deployment thành công chỉ dựa vào trạng thái Worker đã deploy.

```bash
curl -fsS https://cache.ecoma.io/health
curl -fsS https://cache.ecoma.io/ready
```

| Kiểm tra                       | Kết quả mong đợi                  |
| ------------------------------ | --------------------------------- |
| `/health`, `/ready`            | pass                              |
| token hợp lệ / sai / đã revoke | `2xx` / `401` / bị từ chối        |
| `PUT` rồi `GET`                | nội dung khớp                     |
| `GET` hash chưa tồn tại        | `404`                             |
| `PUT` hash đã tồn tại          | bị từ chối, artifact cũ không đổi |
| Nx target chạy hai lần         | lần hai restore từ remote cache   |

---

## 6. Rollback

Rollback theo policy chung (`docs/architecture/02-delivery.md` §8): chọn version đã build/verify, không rebuild. Sau rollback, chạy lại **§5** đầy đủ, rồi rà 4xx/5xx và storage errors.

**Không** xoá cache data như một phần của application rollback. Nếu cần giải phóng dung lượng thì đó là **capacity operation** (§9), không phải rollback.

---

## 7. Monitoring

Theo policy observability chung (`docs/architecture/03-operations.md` §4); giá trị cụ thể của cache nằm ở đây:

```text
Request count · 4xx rate · 5xx rate
Cache hit / miss rate · Request latency
B2 latency · B2 errors · Storage usage · Partition state · Authentication failures
```

| Tín hiệu                         | Diễn giải                                                               |
| -------------------------------- | ----------------------------------------------------------------------- |
| **Cache miss / `404`**           | **Bình thường.** Chỉ điều tra khi hit rate hoặc workload đổi bất thường |
| Authentication failures tăng đột | CI secret sai · credential bị revoke · misuse hoặc abuse                |
| B2 errors lặp lại                | Vấn đề storage/backend, **không** phải cache miss                       |

Log structured, mỗi request có `request_id` để đối soát. **Không bao giờ log** `Authorization`, Bearer token, API key secret hay B2 application key — dùng key ID hoặc principal ID.

---

## 8. Access

| Bề mặt                | Đường đi                      | Quyền                   |
| --------------------- | ----------------------------- | ----------------------- |
| Cache data plane      | `cache.ecoma.io` (public)     | Theo project-scoped key |
| Control plane / admin | Private, Service Binding      | Administrator           |
| Storage backend       | B2 credential least-privilege | Chỉ bucket cache        |

Ranh giới credential đầy đủ → [`01-architecture.md`](./01-architecture.md) §10.

---

## 9. Storage operations

Partition có lifecycle state (semantics → [`01-architecture.md`](./01-architecture.md) §7). Vận hành:

Đổi state partition MUST **không** yêu cầu migrate cache. Khi capacity không còn:

1. ngừng nhận write vào partition bị ảnh hưởng (DRAINING/FULL);
2. giữ read nếu có thể;
3. route write mới sang partition khác còn capacity;
4. theo dõi storage recovery;
5. chỉ bật lại sau khi verify.

Storage usage **không** được đối soát chính xác trong từng cache request.

**Lifecycle** là trách nhiệm của storage, không phải application:

```text
non-current object versions: 3 ngày
incomplete multipart uploads: 1 ngày
```

Không chạy full-bucket scan hay bulk delete trong request path. Cache expiration là hành vi bình thường.

---

## 10. Bootstrap

MVP cần tối thiểu `1 tenant · 1 project · 1 storage partition · 1 B2 bucket · 1 developer key · 1 CI key` (control-plane domain model → [`01-architecture.md`](./01-architecture.md) §2.1). Đây là floor khởi tạo, không phải success criteria: MVP chỉ đạt success khi có **hai tenant trở lên dùng đồng thời** ([`02-requirements.md`](./02-requirements.md) §7) — tenant thứ hai được provision qua control plane sau bootstrap:

```text
Create B2 bucket
      ↓
Create least-privilege B2 credential
      ↓
Configure + deploy Worker
      ↓
Create tenant + project (control plane)
      ↓
Create project-scoped API keys (developer key, CI write key)
      ↓
Configure Nx (§4)
      ↓
Run smoke test (§5)
```

Phân lớp theo hợp đồng canonical ([`architecture/02-delivery.md`](../../architecture/02-delivery.md) §3.2, [ADR-0020](../../domains/staff-access/adr/0020-bootstrap-seed-contract.md)):

- **System-owned** — tenant nội bộ `ecoma-internal` + owner membership của `sub` superadmin. Đây là bước bootstrap, chạy trên bề mặt provisioning/CLI của unit này, không phải route. Tên canonical là `ecoma-internal`; `Ecoma` chỉ là nhãn trong prose.
- **User-owned** — project đầu tiên và API key là dữ liệu do người dùng tạo; chúng đi qua control plane sau khi Worker serving lên, không phải seed. Ghi chú: `remote_cache.tenant_members` chỉ được `SELECT` bởi runtime role (`0002_roles_and_grants.sql`), nên owner membership **không thể** được tạo qua API — đó là lý do bước này buộc phải nằm trên bề mặt migrator/owner.

---

## 11. Credential rotation

**API key** — tạo trước, thu hồi sau; không thu hồi key cũ trước khi consumer đã chuyển sang:

```text
Create new key → Update consumer → Verify new key → Revoke old key
```

**B2 credential** — `Create replacement → Update secret/config → Deploy → Verify GET/PUT → Revoke old credential`. Rotation MUST **không** yêu cầu cache migration.

---

## 12. Failure handling và incident priorities

**Failure modes:**

| Tình huống                      | Xử lý                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cache miss (`404`)**          | Bình thường, **không** cần can thiệp. Nx thực thi task rồi ghi artifact mới                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **B2 unavailable**              | Kiểm tra B2 availability · credentials · bucket config · Worker→B2 connectivity. **Không** coi cache failure là mất source data                                                                                                                                                                                                                                                                                                                                                                  |
| **Worker unavailable**          | Kiểm tra deployment · routes · bindings · secrets · runtime logs. Rollback nếu do deployment                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Control plane unavailable**   | Administrative change tạm thời không dùng được. Data plane vẫn phục vụ nếu `db-remote-cache` còn tới được — nó đọc database mỗi request cho API key, project, lifecycle và quota ([ADR-0017](../../domains/remote-cache/adr/0017-lifecycle-enforcement.md)), nên độ sẵn sàng của data plane bằng độ sẵn sàng của database, không bằng control plane. Control plane và data plane hiện nằm trong cùng Worker `remote-cache`, nên outage control plane không tách rời được khỏi outage data plane. |
| **Stream không replay an toàn** | `503`. Không retry mù one-shot request body                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Incident priorities:**

| Mức    | Triệu chứng                                      | Hành động                                                                                                    |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **P1** | `5xx` spike, Nx không truy cập được remote cache | Verify Worker → verify B2 → inspect deployment gần nhất → rollback nếu do deployment → smoke test            |
| **P2** | `401`/`403` spike                                | Xác định project/key bị ảnh hưởng → key status → CI secret → project authorization → rotate nếu cần          |
| **P2** | Partition → `DRAINING`/`FULL`                    | Verify storage usage → ngừng write partition bị ảnh hưởng → mở capacity khác → verify routing → rà retention |
| **P3** | Cache miss rate tăng                             | Verify service errors → Nx config → cache key/project config → storage availability                          |

**Build correctness luôn độc lập với cache availability.** Cache miss thông thường không phải incident.

---

## 13. Operational invariants

Operator MUST giữ:

- project-scoped access, không global write credential;
- least-privilege storage credentials;
- không secret trong logs;
- không scan storage trong cache request path;
- cache failure **không** trở thành build correctness failure.

Invariant kiến trúc đầy đủ → [`01-architecture.md`](./01-architecture.md) §13.
