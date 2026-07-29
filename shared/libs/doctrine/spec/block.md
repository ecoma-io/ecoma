---
title: "Ecoma Spec: Block"
status: design-end-state
lang: vi
---

# Ecoma Spec: Block

## 1. Định nghĩa

Block là **một manifest có kiểu, bó một tập entity ecoma + giá trị mặc định + dependencies**, phân phối qua Hub.

> **Template = một Block được curate cho một vertical.** Mức "template" trong default cascade (Composition §3) = **tập Block tenant đã cài**, resolve theo thứ tự ưu tiên tenant khai. Khái niệm "template" từ nay có định nghĩa cơ chế — không còn là từ ma.

## 2. Manifest

| Trường | Nội dung | Bắt buộc | |---|---|---| | `identity` | namespace/name + semver; digest do registry sinh (content-addressed) | ✅ | | `publisher` | Identity ký danh (sigstore) | ✅ | | `contents` | Danh sách entity **có kiểu**: process-definition, contract, criterion, role, macro, script, app-profile, driver, cascade-defaults, table-definition, metric-definition… (taxonomy mở) | ✅ | | `defaults` | Giá trị cascade block đóng góp vào mức template | ⬜ | | `dependencies` | block@range khác | ⬜ | | `scope` | **Tổng hợp năng lực bắt buộc khai**: có irreversible effect? credential handle nào? domain nào? spawn policy gì? classification cao nhất của knowledge kèm theo? — nguồn của scope disclosure lúc cài | ✅ | | `license` | Apache/CC0 (free) hoặc EULA publisher (trả phí) | ✅ | | `migrations` | Danh sách migration mà upgrade tới digest này cần chạy; **mỗi mục khai `down` (đường nghịch) hoặc `irreversible_upgrade: true`** — thiếu khai = coi như **chưa có đường về** (bảo thủ, nguyên văn luật NS §8) | ✅ nếu upgrade có migration | | `attestations` | Chữ ký + kết quả analysis lúc pack + badge verified (nếu có) | ✅ tự động |

## 3. Hai trust class của artifact

| Class | Gồm | Kiểm được bằng | Chính sách cài mặc định | |---|---|---|---| | **Definition** | Process, contract, criterion, role, macro, app-profile, defaults | Static analysis **toàn phần** | Cho cài sau disclosure | | **Code** | Driver, custom rule filler — **Connector API chính là rule filler + Contract, phân phối tại đây: câu trả lời của ecoma cho thư viện integration kiểu n8n, không cần khái niệm riêng** | Chữ ký + sandbox; không phân tích kín được | **Reject nếu publisher chưa verified**; luôn cần opt-in tường minh của admin |

## 4. Identity, version, lineage

- Semver cho người; **digest cho máy** — install pin digest vào **lockfile** tenant (artifact versioned; tenant muốn governance thì vòng duyệt lockfile là một workflow ecoma).
- **Không có diamond problem ở runtime**: mọi entity pin version riêng, hai block mang hai version Contract khác nhau cùng tồn tại. Xung đột chỉ còn ở tầng resolve index.
- Tenant fork block = version mới có **lineage** từ gốc; merge upstream là task pair-design. Mọi entity materialize mang provenance trỏ về `block@digest`.

## 5. Vòng đời publish

```
git repo (dev, fork/PR)
 → pack: schema check + FULL static analysis (Composition §4)
 → ký publisher → push OCI → transparency log → index
 → (tùy chọn) review verified = một workflow ecoma → attestation
```

## 6. Install — sáu bước, tái dùng toàn cơ chế sẵn có

1. `resolve` name@range → digest; `verify` chữ ký + transparency log
2. **Re-run static analysis phía tenant** — không tin claim của publisher
3. **Scope disclosure** hiển thị trước khi cài; analysis phát hiện năng lực không khai trong `scope` → **reject**
4. Materialize entity vào thư viện tenant, provenance → block@digest — install khai **scope: `tenant` | `workspace`** (vách mềm Tenant & Identity §3; block private của client A không hiện với đội client B)
5. **Quarantine bằng trust tiers**: filler identity trong block không có calibration tenant → khởi động `gated`/`shadow` theo graduation policy (Role §5) — không có hệ kiểm duyệt mới
6. Ghi lockfile

## 7. Upgrade / Uninstall

- Upgrade = digest mới → **semantic diff theo entity** (làm được vì contents có kiểu) → migration tường minh; process đang chạy đứng yên trên pin cũ (đúng logic Contract/Process pinning).
- **Đường lùi là điều kiện, không phải thiện chí**: upgrade có migration chỉ chạy khi manifest khai `migrations[].down`, **hoặc** khai `irreversible_upgrade: true` — trường hợp sau engine **đòi Gate + bản sao trước khi chạy**, y hệt luật migration major của NS §8. Downgrade = chạy `down` theo thứ tự nghịch rồi pin lại digest cũ (lockfile giữ nguyên digest cũ nên nó luôn resolve được). Án văn: "revert" không kèm down-path chuẩn bị trước là lời nói, không phải cơ chế.
- Không auto-upgrade trong mọi cấu hình mặc định.
- Uninstall: entity còn được instance tham chiếu thì giữ (pin); GC khi hết tham chiếu.

## 8. Public / Private

- Public instance: immutable + `yank` (ẩn resolve, pin cũ sống mãi — kể cả block trả phí khi publisher biến mất).
- Private: mọi OCI registry; **scoped resolution** theo namespace (block private phụ thuộc được block public); air-gap mirror bằng lệnh chuẩn — mirror namespace trả phí kiểm entitlement **tại lúc mirror pull** (vẫn là tầng phân phối, không phải runtime).
- Block = tri thức quy trình = IP doanh nghiệp — private không phải nice-to-have.

## 9. Non-goals

- Block không mang cơ chế runtime mới; không mang calibration (share định nghĩa, không share dữ liệu học — invariant 4).
- Không entitlement/DRM trong engine; không auto-update.
- Đóng góp stats/profile ngược về catalog chỉ qua opt-in + vòng review (nhất quán Self-healing §5).

## 10. Nhật ký quyết định

| Vấn đề | Chốt | |---|---| | Template là gì | Block curate theo vertical; mức template cascade = tập block đã cài theo ưu tiên | | Số registry | 1 protocol, 1 public immutable, N private mirror; Hub là domain thứ ba, cả Platform lẫn RPA nói trực tiếp qua resolve/pull/verify | | Substrate | Git (dev) → OCI (dist) → transparency log → index; semver người / digest máy / lockfile tenant | | Trust nội dung | Re-analyze tenant-side; scope khai ≠ analysis → reject; quarantine bằng trust tiers; code là trust class riêng | | Thương mại | Entitlement chỉ tại phân phối; không DRM; hai tầng license nội dung | | **Đường lùi của upgrade** | `migrations[].down` hoặc `irreversible_upgrade: true` (đòi Gate + bản sao) — mirror nguyên luật NS §8 xuống tầng block; lockfile giữ digest cũ nên pin-lại luôn resolve được |

## Litmus (spec-level, theo L5)

1. Manifest khai thiếu năng lực mà analysis phát hiện → install reject, không phải warning?
2. Hub sập vĩnh viễn — mọi block đã cài (kể cả trả phí) chạy nguyên vẹn nhờ lockfile?
3. Code artifact từ publisher chưa verified bị reject ở mọi cấu hình mặc định?
