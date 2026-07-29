---
title: "Ecoma Spec: Vault & Key Lifecycle"
status: design-end-state
lang: vi
---

# Ecoma Spec: Vault & Key Lifecycle

## 1. Hai trách nhiệm, một subsystem

| Trách nhiệm                                          | Phục vụ ai                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Key lifecycle** — sinh/xoay/hủy khóa mã hóa        | Crypto-shredding (Event Log §4), erasure của Tenant §2b, PII-shredding mapping                  |
| **Secret store** — credential dùng để _gọi ra ngoài_ | Rule filler gọi API, agent tool-call, RPA credential injection (Sandbox §2), model provider key |

Chung một subsystem vì cùng một luật: **giá trị không bao giờ rời khỏi vault**; mọi thứ khác chỉ cầm **handle**.

## 2. Cây khóa — 3 tầng cố định

```
root key (KMS hoặc file — theo hình thái, §3)
 └── tenant DEK (mỗi tenant một khóa dữ liệu)
 └── subject key ((tenant, subject_ref) — Party/actor/PII-mapping)
```

- **Vì sao đúng 3 tầng**: 1 tầng thì không shred nổi _một cá nhân_ (GDPR đòi xóa một Party, không phải cả tenant); tầng tùy tiện thì không rebuild nổi ánh xạ. 3 tầng đủ và cố định.
- **Envelope encryption**: tầng trên bọc tầng dưới — hủy tầng trên là hủy toàn bộ nhánh.
- **Ánh xạ `subject_ref → key_id` là projection từ log** (rebuild được); **key material thì không bao giờ** — nó chỉ sống trong vault backend.
- Entry/artifact mang **`key_id` đã dùng** (không mang khóa). Đây là điều kiện để §4 chạy.

## 3. Root key theo hình thái cài đặt (nhất quán ADR-0002)

| Hình thái                        | Root key                                                                   | Biên cứng                                        |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| Small-stack (binary/1-container) | File ngoài **data directory**, quyền hẹp (0600), đường dẫn khai tường minh | **Backup script CẤM chạm** — kiểm bằng litmus #4 |
| Compose-production / K8s / Cloud | **KMS adapter** (envelope: KMS giữ root, hệ chỉ cầm DEK đã bọc)            | Root không bao giờ nằm trên đĩa ứng dụng         |

**Luật xuyên hình thái — ba vế, không tách rời** (vế (a) chốt; vế (b)(c), đóng blocker +):

| Vế                                    | Luật                                                                                                                                                                                                            | Vì sao không bỏ được vế nào                                                                                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Ngoài backup dữ liệu**          | **Root key và mọi khóa nằm NGOÀI đường backup dữ liệu**; escrow (nếu có) chịu cùng lệnh shred                                                                                                                   | Thiếu (a): khôi phục backup = khôi phục cả dữ liệu lẫn khóa ⇒ crypto-shredding là giả                                                                                                                                                                                                    |
| **(b) Có đường DR riêng — theo TẦNG** | **root key + tenant DEK: BẮT BUỘC có đường sao lưu/khôi phục tách biệt** (khai tường minh trong tài liệu deploy). **Subject key: KHÔNG có bản sao point-in-time nào** — nó là thứ bị hủy khi một Party đòi quên | Thiếu (b): đĩa chết ⇒ backup dữ liệu còn nguyên nhưng không giải mã được gì ⇒ "restore backup" là lời hứa suông. Không tách theo tầng thì (b) giết (a): sao lưu tất-cả-khóa = hồi sinh được khóa đã shred                                                                                |
| **(c) Chỉ replica _tiến-lên-trước_**  | Mọi bản sao key material phải là **replica mà lệnh `destroy` replicate được tới**; **CẤM snapshot point-in-time của key store** (snapshot vault, standby có thể rewind, backup file vault theo lịch)            | Thiếu (c): (b) mở lại đúng lỗ (a) ở cửa khác — khôi phục snapshot vault về trước thời điểm shred hồi sinh subject key. Đây là **luật giao thoa chiều ngược (P3b)**: cơ chế _khôi phục_ phải khai điều kiện đủ để đọc, và cơ chế _xóa_ phải phủ mọi **loại** bản sao, không chỉ mọi _nơi_ |

**Bootstrap root key là cơ chế, không phải lời dặn**: provisioning (Tenant §2b) phát root key **đúng một lần**, và **engine đòi một thử thách xác nhận** (nhập lại checksum của khóa đã lưu) trước khi cho tenant vào `active`; thử thách đạt/không đạt là **entry trong log**. Án văn: một checkbox "tôi đã lưu khóa" là nửa-cơ-chế — không chứng minh được điều gì; checksum thì chứng minh được, và kiểm được sau này khi điều tra sự cố.

## 4. Rotate ≠ Shred — hai thao tác khác bản chất

|                        | Rotate                                                                 | Shred                                                                                 |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Ý nghĩa                | Hạn chế phạm vi rủi ro theo thời gian                                  | **Xóa dữ liệu vĩnh viễn**                                                             |
| Cơ chế                 | Khóa mới cho **ghi mới**; khóa cũ **giữ lại để đọc**                   | **Hủy khóa** ở tầng tương ứng                                                         |
| Re-encrypt dữ liệu cũ? | **KHÔNG** — re-encrypt entry cũ = sửa entry cũ = phạm append-only (E5) | Không cần                                                                             |
| Kết quả                | Dữ liệu cũ vẫn đọc được                                                | Entry cũ **vĩnh viễn không giải mã được** — đúng ý đồ, log vẫn nguyên vẹn về cấu trúc |

- Shred là **entry** trong log: ai ra lệnh, phạm vi (subject/tenant), key_id bị hủy, thời điểm — bản thân sự kiện xóa vẫn có bằng chứng (nghịch lý audit-vs-erasure giải bằng: _metadata sự kiện ở lại, nội dung biến mất_).
- Shred **không thể hoàn tác** — engine đòi Gate (capability `key_admin` + `distinct_filler_from` khi cấu hình chặt).
- **Shred × replica**: lệnh shred áp **cùng lượt** lên mọi replica tiến-lên-trước (§3 vế (c)); replica nào không xác nhận `destroy` trong cửa sổ khai báo → **escalation, không bao giờ báo shred hoàn tất**. Vì đã cấm snapshot point-in-time, không tồn tại bản sao nào ngoài tầm lệnh này — đó là điều kiện để litmus #7 pass.

## 5. Secret store — handle, không phải giá trị

- Secret có **id + scope + version + lineage**; consumer nhận **handle**, không bao giờ nhận giá trị (Sandbox §2: injection tại tầng driver — executor "không chạm giá trị").
- **Ai giải mã được gì = capability theo scope**; mọi lần lấy secret là entry (`secret_accessed` — actor, secret_id, mục đích) → truy vết được, phát hiện được lạm dụng.
- Rotate secret = version mới; consumer pin theo id (không pin version) → xoay không vỡ quy trình đang chạy.
- **Biên test**: một **test run scope** (Test Harness §1) **không resolve được secret handle của production** — engine từ chối tại vault, phát entry lý do. Án văn: `test_behavior: forbidden` chỉ chặn effect **ghi** ra ngoài; một test đọc dữ liệu khách hàng thật bằng khóa thật vẫn là rò rỉ, và nó là effect _đọc_ nên không bị chặn ở cửa contract. Chạy test với secret thật đòi khai tường minh + capability riêng (K5: thiếu khai = chặt hơn).
- **Masking**: giá trị secret không bao giờ vào log/artifact/noti — masking từ tầng perception (RPA) và tầng adapter (Platform), không redact hậu kỳ.

## 6. Adapter (port này cũng "default ≠ coupling")

Backend khả dĩ: file-based (small-stack) · KMS đám mây (AWS/GCP/Azure) · HashiCorp Vault · HSM. Contract của port: `generate` / `wrap` / `unwrap` / `rotate` / `destroy` / `get_secret`. **Hai điều kiện chung** (backend thiếu một trong hai thì không đủ tư cách chạy crypto-shredding — khai tường minh trong tài liệu deploy):

1. `destroy` **không thể khôi phục**.
2. **Không cung cấp — hoặc cho phép tắt — mọi cơ chế snapshot/rewind point-in-time trên key material** (§3 vế (c)). Backend có soft-delete/recovery-window bắt buộc: chỉ hợp lệ nếu cửa sổ đó khai được và **lệnh shred chỉ báo hoàn tất sau khi cửa sổ đóng**.

## 7. Non-goals

- Không tự viết thuật toán mã hóa — dùng primitive chuẩn qua thư viện đã kiểm.
- Không lưu secret ngoài vault; không "chế độ trần không mã hóa".
- Không tự động shred theo lịch — shred luôn là hành động có chủ đích qua Gate.
- Không quản lý khóa của _tenant tự mang_ (BYOK) hiện tại — cửa mở qua adapter, ghi khi cần.

## 8. Nhật ký quyết định

| Vấn đề                  | Chốt                                                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cây khóa                | 3 tầng cố định: root → tenant DEK → subject key; ánh xạ là projection, key material thì không                                                                                                                                           |
| Root key                | Theo hình thái (file ngoài data-dir ↔ KMS); **luôn ngoài đường backup**; escrow chịu cùng lệnh shred                                                                                                                                    |
| **Khôi phục khóa (DR)** | Ba vế §3: ngoài-backup + **DR bắt buộc cho root/tenant-DEK** + **subject key không có bản sao point-in-time**. Án văn: hai vế đầu không tách rời — thiếu vế 2 thì "restore backup" là lời hứa suông, thiếu phân tầng thì vế 2 giết vế 1 |
| **Loại bản sao**        | Chỉ **replica tiến-lên-trước** (destroy replicate được); **cấm snapshot point-in-time key store**. Án văn: cấm-mọi-_nơi_ không đủ, phải cấm cả một _loại_ bản sao — nếu không, lỗ backup×shred tái sinh ở cửa vault                     |
| **Bootstrap**           | Phát root key một lần + **thử thách checksum** trước khi tenant vào `active`; kết quả là entry. Checkbox "tôi đã lưu" = nửa cơ chế                                                                                                      |
| **Biên test**           | Test run scope không resolve secret production — `forbidden` chỉ chặn effect ghi, không chặn đọc                                                                                                                                        |
| Rotate                  | Không re-encrypt (append-only bất khả xâm phạm); entry mang key_id                                                                                                                                                                      |
| Shred                   | Hủy khóa; sự kiện shred là entry; không hoàn tác; qua Gate                                                                                                                                                                              |
| Secret                  | Handle-only, scope + capability, mọi truy cập là entry, masking từ gốc                                                                                                                                                                  |
| Adapter                 | Điều kiện tối thiểu: `destroy` không khôi phục được                                                                                                                                                                                     |

## Litmus (spec-level, theo L5)

1. Shred một Party: mọi entry/artifact chứa PII của người đó **không giải mã được nữa**, trong khi log vẫn replay được và mọi entry khác nguyên vẹn?
2. Rotate khóa: dữ liệu cũ vẫn đọc được, **không entry cũ nào bị viết lại**?
3. Khôi phục backup mới nhất trên máy trắng: dữ liệu đã shred trước đó **vẫn không đọc được** (vì khóa không nằm trong backup)?
4. Small-stack: backup script chạm vào file root key → **litmus fail** (kiểm tự động trong CI)?
5. Một consumer bất kỳ (rule filler, agent, RPA driver) có đường nào lấy được **giá trị** secret thay vì handle?
6. **Máy trắng + root key từ đường DR**: khôi phục backup dữ liệu → mọi dữ liệu **chưa** shred đọc được bình thường, hệ vào `active` được — và nếu **không** có đường DR thì engine nói thẳng "không thể khôi phục", không giả vờ chạy được?
7. Shred một Party, sau đó khôi phục **mọi** bản sao khóa còn tồn tại (replica, escrow, standby): dữ liệu của Party đó **vẫn không đọc được** — và không tồn tại một snapshot point-in-time nào của key store để thử?

## FMEA (theo F8)

| Hỏng                                           | Phát hiện                                            | Phục hồi                                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mất toàn bộ máy / đĩa chết**                 | Không unwrap được DEK nào                            | **Khôi phục root key từ đường DR §3(b)** → restore dữ liệu → replay. **Không có DR = mất vĩnh viễn, và đó là thiết kế đã khai**, không phải sự cố ngầm |
| **Snapshot key store tồn tại trái luật §3(c)** | Kiểm cấu hình backend lúc khởi động (điều kiện §6.2) | Engine **từ chối vai crypto-shredding** trên backend đó — không bao giờ hứa xóa thứ mình không xóa được                                                |
| Vault backend down                             | `unwrap`/`get_secret` lỗi                            | Task đi `on_fail/escalate`; **không có chế độ chạy-không-mã-hóa** (§7) — dừng an toàn hơn chạy hở                                                      |
| Replica không xác nhận `destroy` trong cửa sổ  | Đối chiếu ack của từng replica                       | **Escalation, KHÔNG báo shred hoàn tất** — lời hứa xóa chỉ được phát khi mọi bản sao đã chết                                                           |
| Root key rò (nghi bị chiếm)                    | Audit `secret_accessed` bất thường / báo cáo ngoài   | **Rotate toàn cây** (khóa mới cho ghi mới, khóa cũ giữ để đọc — §4); rotate **không** là shred, dữ liệu cũ vẫn đọc được; đánh giá riêng phần đã lộ     |
| Ánh xạ `subject_ref → key_id` drift            | Checksum theo log-position (Working Data §2)         | Rebuild projection từ log — **key material không rebuild được**, đó là lý do §2 tách hai thứ này                                                       |
| Thử thách checksum bootstrap không đạt         | Entry `key_bootstrap_failed`                         | Tenant **ở lại `provision`**, không vào `active` (Tenant §2b) — không có tenant nào sống mà chủ không giữ nổi khóa                                     |
