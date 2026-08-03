---
title: "Process Test Harness"
status: design-end-state
canonical-sha: dc0efa3e425c
---

# Process Test Harness

## 1. Test mode = một mode của engine, không phải engine thứ hai

- **Test run scope**: test run là **một lần chạy có nhãn**, **trong chính tenant sở hữu definition**. Mọi entry nó sinh mang `run_kind: test` + `test_run_id`. **Cách ly = bộ lọc của projection**, không phải một biên cứng mới.
- **Án văn** — vì sao KHÔNG dùng một tenant riêng: tenant là **biên cứng duy nhất** của hệ (Tenant §2). Đẻ "tenant `test`" buộc phải trả lời cardinality/chủ sở hữu/vòng đời/key-tree/metering, và buộc phải mở một **đường copy artifact xuyên tenant** cho definition + fixture — mà Artifact Store §4 cấm tường minh (dedup cross-tenant là side-channel) và invariant 4 cấm học cross-tenant. Nhu cầu thật của harness chỉ có ba, và cả ba **đã có cơ chế**: (1) không effect ra ngoài → `test_behavior` tại Contract; (2) không đầu độc flywheel → đường ghi calibration duy nhất là Judgment hợp lệ (Calibration §2); (3) không bẩn dữ liệu production → mọi write là event, lọc theo nhãn là đủ. **Thêm khái niệm để giải bài toán đã có cơ chế = nửa-cơ-chế đắt hơn** (J3 áp lên chính patch).
- **Hệ quả của nhãn** (engine ép, không phải quy ước):

| Chiều                      | Luật với `run_kind: test` _(nhãn có **nhà canonical** tại Event Log §1/§3 — bảng này chỉ liệt lập trường của từng consumer, không khai lại nhãn;)_ |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calibration                | Judgment sinh trong test run **không bao giờ vào cell production** (Calibration §2 đọc theo nhãn)                                                  |
| Metering / quota / billing | Projection metering **loại nhãn test** (Event Log §3) — trừ phần chi phí tính tiền thật (token, CPU sandbox) vẫn đo, vì nó có xảy ra               |
| DataTable / Working Data   | Write của test run vào **projection tách theo nhãn**; bảng production không thấy                                                                   |
| Effect ra ngoài            | Chặn tại Contract (§5)                                                                                                                             |
| Secret                     | Không resolve handle production (Vault §5)                                                                                                         |
| n=1 (D5)                   | User không thấy khái niệm nào: chỉ có nút "chạy thử"                                                                                               |

- **Test run là entry trong log**: có id, definition@version, fixture@version, kết quả, provenance → so sánh được giữa các version, dựng lại được.
- **Cấm nhánh code riêng cho test** (A3): cùng engine, cùng primitive, cùng đường ghi — chỉ khác _nhãn run_, _filler binding_ và _contract test_behavior_.

## 2. Fixture — dữ liệu mồi có version

| Thành phần         | Nội dung                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Seed entries       | Bộ entry khởi tạo (task, artifact, party, working data) — replay-able                                              |
| Filler binding     | Ánh xạ Role → mock filler (§3)                                                                                     |
| Recorded responses | Phản hồi LLM/HTTP đã ghi (dùng ở chế độ `replay` — §4)                                                             |
| Clock              | Thời gian ảo: timer/SLA **tua nhanh được** (Escalation timers là entry → tua = phát entry sớm, không cần chờ thật) |

Fixture là **artifact có id + version + lineage** (như mọi thứ trong hệ) — sửa fixture sinh version mới, so được kết quả trước/sau.

## 3. Mock filler — vẫn là Filler thật

- Mock filler có **identity thật** (`mock:<name>@version`), đăng ký qua **đúng Filler interface** — nó chỉ là một filler trả kết quả định sẵn. Không cơ chế mới, và đây là bằng chứng đối xứng người/AI/mock đứng vững.
- **`environment: test` là một chiều của filler identity, KHÔNG phải trust tier thứ 5**: bảng trust tier của Role §5 giữ đúng **4 tier** (`shadow/gated/sampled/autonomous`) — taxonomy tier chỉ có một nhà. Filler mang `environment: test` thì **không đủ tư cách được gán vào task production**, độc lập với tier của nó. Án văn: trộn hai trục (mức-tin-cậy × môi-trường) vào một enum tạo nguồn sự thật thứ hai cho taxonomy tier (E5/G6).
- **Biên cứng: Judgment của mock filler KHÔNG BAO GIỜ vào cell calibration production.** Án văn: cell calibration là tài sản của tổ chức (Calibration §0); đầu độc bằng dữ liệu giả là phá flywheel không đảo được. Thi hành bằng nhãn `run_kind: test` trên entry (§1), không bằng một biên tenant mới.
- Mock được phép: trả kết quả cố định, trả theo thứ tự, fail có chủ đích, chậm có chủ đích (test SLA/escalation).

## 4. Non-determinism — 3 chế độ

| Chế độ   | Dùng khi                | Hành vi                                                                                                       |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `replay` | **Mặc định trong CI**   | Chỉ đọc recorded responses — deterministic tuyệt đối                                                          |
| `record` | Khi tạo/làm mới fixture | Gọi thật, ghi phản hồi vào fixture (có nhãn chi phí + thời điểm)                                              |
| `live`   | Nightly / trước release | Gọi thật, chấp nhận không lặp lại — kết quả mang nhãn `non_deterministic`, không được là điều kiện chặn merge |

## 5. Effect — biên an toàn nằm ở Contract

- Mỗi contract khai `test_behavior`: `mock` · `dry_run` · `forbidden` (Handoff §3). **Thiếu khai resolve về `forbidden`** — engine chặn và ghi entry lý do.
- Harness **không bao giờ tự đoán** effect nào an toàn — nó chỉ thi hành khai báo. Án văn: đoán sai một lần = gửi email thật cho khách hàng thật.
- **`dry_run` đòi adapter khai năng lực**: `dry_run` là **năng lực của adapter** (channel/driver/HTTP/mail), không phải của contract. Adapter khai `supports_dry_run`; **contract khai `dry_run` mà adapter không hỗ trợ → resolve về `forbidden`** (K5: thiếu năng lực thì chặt hơn, không lỏng hơn), và **static analysis kiểm cặp `contract × adapter`** trước khi chạy (Composition §4). Án văn: không có luật này thì đúng chỗ harness thề "không bao giờ đoán" lại là chỗ nó phải đoán — hoặc gửi mail thật, hoặc im lặng bỏ qua.
- **Secret**: test run scope **không resolve được secret handle production** (Vault §5). Án văn: `forbidden` chỉ chặn effect _ghi_ ra ngoài; một test _đọc_ dữ liệu khách hàng thật bằng khóa thật vẫn là rò rỉ và không bị cửa contract chặn.
- Chạy thật trong test đòi khai tường minh + capability — có, nhưng phải cố ý.

## 6. Assertion — trên log, không trên UI

| Loại         | Ví dụ                                                         |
| ------------ | ------------------------------------------------------------- |
| Reachability | Task tới được Gate X / trạng thái Y                           |
| Judgment     | Verdict = reject với criterion Z                              |
| Timer        | SLA nổ sau khoảng T (clock ảo)                                |
| **Negative** | **Không effect nào rời hệ**; không entry loại E nào xuất hiện |
| Invariant    | Mọi Gate có Judgment; không attempt nào không có lease        |

Assertion là **artifact khai báo** (có version), gắn với definition — không phải code viết tay rải rác.

## 7. Conformance suite — cùng cơ chế, khác subject

Suite của một **interface** (◆G0–G4) thay vì của một definition: cùng fixture + assertion, nhưng chạy trên **implementation** để kiểm nó có tuân interface không. Một harness, hai dụng.

- Suite là **artifact có version**; **đổi suite = đổi giao diện = breaking** (đi đường major — playbook giao hàng (không công bố) §3).
- Nơi sống: CI (playbook giao hàng (không công bố)) — track qua gate = **pass suite**, không phải "đã đọc kỹ".
- Chạy được **độc lập** trên bất kỳ implementation nào (điều kiện để mở track song song).
- **Mọi projection bắt buộc mang negative test `run_kind` trong suite phân xử nó** (Event Log §3 — van cơ chế của cược B11): projection mới không kèm test này thì fail chính suite đó, chặn merge. Đây là chỗ harness trả giá trị cho _chính luật cách ly test_ mà nó dựa vào.

## 8. Ai chạy — 3 consumer

| Consumer | Khi nào                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User     | Trước khi publish process definition (Composition: static analysis bắt lỗi cấu trúc; harness bắt lỗi _hành vi_)                                                                                                                                                                                                                                                                                                                                                                                                           |
| CI       | Mọi PR (3 tầng — playbook giao hàng (không công bố) §3); conformance suite tại mọi gate                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Hub**  | **Verified review**: block/template mang suite riêng → publisher chứng minh block chạy đúng. Suite là **bằng chứng phụ, không bao giờ là điều kiện đủ** để cấp badge (Judgment của reviewer mới là); chạy trong **test run scope của operator**: effect `forbidden` toàn phần, **0 secret handle**, trần thời gian/tài nguyên. Với block trust-class `code`, vòng duyệt chạy **bên trong runtime sandbox** (Runtime Sandbox §6) — không tồn tại đường "chạy code chưa verified ngoài chuồng đó để được verified" (Hub §7) |

## 9. Non-goals

- Không phải load/perf testing (khác mục đích, khác cơ chế).
- Không nhánh engine riêng, không store/database riêng cho test — **và không tenant riêng cho test** (§1 án văn).
- Không tự sinh assertion bằng AI hiện tại (cửa mở: Drafter đề xuất, người duyệt qua Gate — đúng pair-design).
- Không thay static analysis (Composition §4) — hai lớp khác nhau: cấu trúc vs hành vi.

## 10. Nhật ký quyết định

| Vấn đề                                     | Chốt                                                                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bản chất                                   | Mode của engine + **test run scope có nhãn** trong chính tenant, không phải hệ thứ hai; test run là entry                                                                                                                                                       |
| **Vì sao không phải tenant riêng**         | Tenant là biên cứng duy nhất; đẻ tenant `test` buộc mở đường copy artifact xuyên tenant (Artifact Store §4 cấm) và trả lời cardinality/key-tree/metering. Ba nhu cầu thật đã có cơ chế: `test_behavior`, đường-ghi-calibration-qua-Judgment, mọi-write-là-event |
| **`test` là environment, không phải tier** | Trust tier giữ đúng 4 (Role §5) — trộn mức-tin-cậy với môi-trường = nguồn sự thật thứ hai của taxonomy tier                                                                                                                                                     |
| **`dry_run`**                              | Là **năng lực của adapter** (`supports_dry_run`); không hỗ trợ → `forbidden`; static analysis kiểm cặp contract×adapter                                                                                                                                         |
| **Secret trong test**                      | Không resolve handle production — `forbidden` chỉ chặn _ghi_, không chặn _đọc_                                                                                                                                                                                  |
| Biên effect                                | Khai tại **Contract** (`test_behavior`), mặc định `forbidden` — harness thi hành, không đoán                                                                                                                                                                    |
| Mock filler                                | Filler thật, tier `test`, **cấm tuyệt đối vào calibration production**                                                                                                                                                                                          |
| LLM                                        | replay (CI mặc định) / record / live (nightly, không chặn merge)                                                                                                                                                                                                |
| Assertion                                  | Artifact khai báo, đo trên log, có loại **negative**                                                                                                                                                                                                            |
| Conformance suite                          | Cùng cơ chế, subject = implementation; đổi suite = breaking                                                                                                                                                                                                     |
| Quan hệ với static analysis                | Bổ sung, không thay: cấu trúc vs hành vi                                                                                                                                                                                                                        |

## Litmus (spec-level, theo L5)

1. Chạy một process có contract gửi email trong test mode: **không email nào rời hệ**, log ghi rõ bị chặn vì `forbidden`?
2. Cùng fixture + `replay` chạy 100 lần → **kết quả giống hệt** (deterministic)?
3. Judgment sinh bởi mock filler có đường nào lọt vào cell calibration production?
   3b. Contract khai `dry_run` trên một adapter **không** khai `supports_dry_run`: engine resolve về `forbidden` và static analysis báo lỗi trước khi chạy — không tồn tại đường chạy thật hoặc bỏ qua im lặng?
4. Test SLA 7 ngày xong trong **vài giây** bằng clock ảo — không sửa một dòng definition nào?
5. Một implementation mới của interface ◆G bất kỳ: chạy được conformance suite **độc lập**, không cần phần còn lại của hệ?
