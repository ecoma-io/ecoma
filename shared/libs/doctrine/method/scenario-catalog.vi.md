---
title: "Scenario catalog"
status: design-end-state
canonical-sha: a84108fb405b
---

# Scenario catalog

## Phần 1 — Scenario battery (seed, 40 kịch bản)

| ID  | Kịch bản (1 dòng)                                         | Verdict gần nhất                            |
| --- | --------------------------------------------------------- | ------------------------------------------- |
| S01 | Webhook → transform → gọi API                             | ✅                                          |
| S02 | Schedule kéo report → email                               | ✅                                          |
| S03 | Form → validate → ghi CRM                                 | ✅                                          |
| S04 | n=1 giao AI viết, tự duyệt qua inbox                      | ✅                                          |
| S05 | RPA standalone điền form web không API                    | ✅                                          |
| S06 | Brief → AI draft → người edit → publish CMS (flagship)    | ✅                                          |
| S07 | Chatbot FAQ → bí → chuyển người                           | ✅                                          |
| S08 | Hóa đơn PDF qua email → extract → duyệt → ghi sổ          | ✅                                          |
| S09 | Sàng lọc CV; ứng viên = external filler                   | ✅                                          |
| S10 | Onboarding song song IT(RPA)+HR(người)+manager            | ✅                                          |
| S11 | AI writer shadow người 2 tuần → graduation                | ✅                                          |
| S12 | Người mới shadow quy trình AI để học                      | ✅                                          |
| S13 | Hoàn tiền Messenger: dùng policy internal, trả lời public | ✅ (leakage-gate — sinh từ finding)         |
| S14 | Đàm phán B2B nhiều vòng + legal + provisioning            | ✅                                          |
| S15 | Agent phân rã landing page → 7 subtask, 2 cho người       | ✅                                          |
| S16 | Model provider sập giữa 50 task → correlation gộp         | ✅                                          |
| S17 | Migrate quy trình đang chạy 3 tuần                        | ✅                                          |
| S18 | Cài block Hub, fork criteria, nhận upstream               | ✅                                          |
| S19 | Audit "ai duyệt, tri thức nào, model nào"                 | ✅                                          |
| S20 | Nhân viên nghỉ đột ngột giữa 12 task treo                 | ✅                                          |
| S21 | Hai process đua ghi một record CRM                        | ✅ (serialization_key/Lease)                |
| S22 | Prompt injection "xuất toàn bộ policy"                    | ✅                                          |
| S23 | Tắt máy giữa phiên RPA đã qua commit point                | ✅                                          |
| S24 | Spam 1000 tin/phút vào chatbot                            | ✅                                          |
| S25 | Block giấu action irreversible không khai                 | ✅ reject                                   |
| S26 | Publisher block trả phí phá sản                           | ✅                                          |
| S27 | Khách chat đòi xóa dữ liệu (GDPR)                         | ✅ shredding                                |
| S28 | "AI không tự gửi email cho khách VIP"                     | ✅ criterion+policy                         |
| S29 | Hai bộ phận sửa cùng contract dùng chung                  | ✅                                          |
| S30 | Self-host mất điện giữa 200 task                          | ✅ replay                                   |
| S31 | Agency 40 client tách chất lượng theo client              | ✅ (workspace dimension)                    |
| S32 | Dùng ecoma phát triển chính ecoma                         | ✅                                          |
| S33 | Gộp 2 tenant (M&A)                                        | ⚠️ operational, ngoài trần                  |
| S34 | Regulator audit realtime                                  | ✅ projection                               |
| S35 | Role được lấp bởi process con                             | ✅ (filler `process` — sinh từ finding)     |
| S36 | A/B hai quy trình cạnh tranh bằng outcome                 | ✅ shadow process-filler                    |
| S37 | Air-gap quốc phòng                                        | ✅                                          |
| S38 | Escalation ping-pong vô hạn                               | ✅ chain tuyến tính                         |
| S39 | Người tự approve việc mình làm ở 2 role                   | ✅ (distinct_filler_from — sinh từ finding) |
| S40 | Chi phí model tăng vọt giữa tháng                         | ✅                                          |

## Phần 1b — Exploration full-run #1 (S41–S44, từ vùng mù đã khai)

| ID  | Kịch bản                                                                           | Verdict                                                                                                                 |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| S41 | Khách VIP hồ sơ memory dài + yêu cầu hoàn tiền lớn (memory×irreversible×external)  | ✅ memory scope theo party + sàn Gate + leakage-gate                                                                    |
| S42 | Process-filler lồng 2 cấp, instance con kẹt terminal-hold                          | ✅ compose: task cha treo → SLA cha bắn escalation riêng — không cần cơ chế xuyên cấp                                   |
| S43 | Block private của client A trong tenant agency đa workspace                        | ⚠️→✅ **finding: install thiếu scope workspace — đã vá Block §6**                                                       |
| S44 | Sync-response + leakage-gate dưới tải                                              | ✅ verifier máy trong time_budget; quá → fail/degrade                                                                   |
| S45 | KB kéo từ git/website + support chatbot (dogfood ecoma-docs); nguồn web bị sửa lén | ✅ composition thuần: trigger→extract→Gate→materialize; web-source Gate chặt hơn git; drift = hash mismatch → Violation |

## Phần 1c — Exploration full-run #2 (S46–S54) — 4 vùng mù khai ở full-run #1 + 5 sinh mới

| ID  | Kịch bản                                                                                                | Nguồn                       | Verdict                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S46 | Node attended × takeover × màn hình đang hiện secret; người trợ giúp **từ xa** xem cùng                 | vùng mù #1                  | ⚠️→✅ **finding major: live-view là consumer thứ 4 đứng ngoài chốt masking** — vá Sandbox §3 (live-view = projection Scene sạch; driver không hỗ trợ → attended-only) |
| S47 | Agency: distill memory từ 30 khách của client A → Knowledge; client B dùng chung tenant, khác workspace | vùng mù #2                  | ⚠️→✅ **finding major: distill không khai chiều workspace** — vá Memory §5 (mặc định workspace hẹp nhất) + Knowledge §1 (Collection có scope) + rubric C6             |
| S48 | Bootstrap admin tự cấp capability                                                                       | vùng mù #3                  | ✅ **accepted-by-owner** (chủ quyền tenant có audit) — không tính lại, theo R4                                                                                        |
| S49 | Publisher độc tự đẩy block của mình qua vòng review verified để lấy badge, rồi ship artifact `code`     | vùng mù #4                  | ⚠️→✅ **finding major: cửa duy nhất của artifact code không khai chống tự-duyệt** — vá Hub §7 (`distinct_filler_from` + `unverify` có event)                          |
| S50 | Khách đòi quên → shred; 2 tuần sau ops khôi phục backup từ trước đó để cứu sự cố                        | desk-sim P3 (mới)           | ⚠️→✅ **BLOCKER: backup hồi sinh dữ liệu đã shred** — vá Event Log §4 (khóa ngoài đường backup; escrow chịu cùng lệnh shred)                                          |
| S51 | `singleton: true` đóng sổ tháng; holder chết **sau** khi đã ghi effect ra hệ ngoài; TTL hết             | implementation-sketch (mới) | ⚠️→✅ **finding major: Working Data §3 nói "tự nhả", RPA NS §4 nói "không silent re-run"** — vá: lease `orphaned`, escalation terminal quyết                          |
| S52 | Agent filler gọi tool ngoài (giao thức kiểu MCP) có side-effect, không khai Effect ở Task               | nhóm O (mới)                | ⚠️→✅ **finding major: tool-call chưa có nhà** — vá Task §5 (hành vi-trong-filler vs Task; 2 biên cứng; tool protocol = adapter)                                      |
| S53 | Tenant ngừng trả tiền → suspend; 3 tháng sau đòi export rồi xóa sạch                                    | P-run (mới)                 | ⚠️→✅ **finding major: vòng đời tenant không có nhà** — vá Tenant §2b (provision→suspended→export→purge)                                                              |
| S54 | Release major đã migrate schema DataTable; phát hiện lỗi, cần quay lại                                  | P2/I7 (mới)                 | ⚠️→✅ **finding major: rollback không có nhà** — vá NS §8 (down-migration hoặc `irreversible_migration`) + Composition §4                                             |

## Phần 1d — Exploration full-run #3 / (S55–S62) — 5 vùng mù khai ở #2 + 3 sinh mới

| ID  | Kịch bản                                                                                                   | Nguồn                                           | Verdict                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S55 | Ổ cứng self-host chết; backup dữ liệu nguyên vẹn; root key **ngoài** đường backup theo đúng luật           | desk-sim P1 `backup/restore` (chiều ngược)      | ⚠️→✅ **BLOCKER mất toàn bộ dữ liệu dù backup nguyên** — vá Vault §3 ba-vế (DR bắt buộc cho root/tenant-DEK, subject key không có bản sao) + bootstrap thử-thách-checksum + FMEA; litmus Vault #6                                             |
| S56 | Khách đòi quên → shred; ops khôi phục **snapshot của chính key store** (không phải backup dữ liệu)         | vùng mù `key rotation × log cũ` (khai ở #2)     | ⚠️→✅ **major S50 tái sinh ở cửa khác** — vá luật _loại bản sao_: chỉ replica tiến-lên-trước, cấm snapshot point-in-time key store (Vault §3(c)/§4/§6.2, Event Log §4) → sinh **P3b**                                                         |
| S57 | Người dùng bấm **Approve** trên app desktop attended (Tauri, ADR-0005) khi máy đang offline với server     | desk-sim ADR→trần                               | ⚠️→✅ **major kênh nội-máy chưa có tên trong trần + nguy cơ đường ghi riêng của UI** — vá RPA NS §4 ba biên cứng; litmus RPA #10 (tắt kênh → runtime chạy đủ)                                                                                 |
| S58 | Test một process của tenant A: definition + fixture phải vào "tenant `test`"                               | implementation-sketch trên spec mới             | ⚠️→✅ **major tenant `test` không có nhà + buộc mở đường copy artifact xuyên tenant** (Artifact Store §4 cấm) — vá bằng **test run scope có nhãn**, 0 biên mới                                                                                |
| S59 | Test run chạy `read` thật vào CRM của khách bằng credential production; effect ghi đã bị `forbidden`       | desk-sim F3 trên spec mới                       | ⚠️→✅ **major `forbidden` chỉ chặn _ghi_, không chặn _đọc_** — vá Vault §5: test run scope không resolve secret production                                                                                                                    |
| S60 | Contract khai `test_behavior: dry_run` nhưng adapter mail không có chế độ dry-run                          | implementation-sketch                           | ⚠️→✅ **major đúng chỗ harness thề "không đoán" lại phải đoán** — vá `supports_dry_run` của adapter + resolve về `forbidden` + static analysis cặp contract×adapter                                                                           |
| S61 | Dev cộng đồng gửi PR vào repo public (là **mirror** đã lược `cloud/`)                                      | P5 dòng _Contribution_                          | ⚠️→✅ **major charter khai _cổng_ (CLA) mà không khai _đường_** — PR vào mirror không merge đi đâu; vá playbook giao hàng (không công bố) §6 luồng replay-lên-trunk-private                                                                   |
| S68 | Một người kéo card trên GitHub Projects sang cột "Done" cho việc chưa có exit-litmus nào pass              | ranh giới board                                 | ⚠️→✅ Board sở hữu **trạng thái**, không sở hữu **định nghĩa xong**; exit-litmus chỉ ở roadmap §4. Card không trace được về một ID = phạm vi chưa quyết ⇒ **PR sửa roadmap trước, không kéo card**                                            |
| S69 | Ai đó thêm cột "Priority" trên board để sắp lại việc                                                       | ranh giới board                                 | ⚠️→✅ **Cấm**: §2 (thứ tự đáng làm) và §3b (điều kiện mở khóa) đã là hai nguồn; cột gõ tay là nguồn thứ ba và _gần tay nhất nên sẽ thắng cả hai_                                                                                              |
| S64 | Giữ backup 5 năm trong khi support window là "major hiện tại + 1"                                          | giao thoa #1                                    | ⚠️→✅ Retention ≤ support window, hoặc khai **restore path có diễn tập**; vượt mà thiếu ⇒ **cảnh báo lúc khởi động**                                                                                                                          |
| S65 | Cần lùi một bản nâng cấp **sau** khi cửa sổ rollback đã hết                                                | giao thoa #2                                    | ⚠️→✅ Đó **không phải rollback** — là restore+replay, mất dữ liệu từ điểm backup; thủ tục **cấm** gọi chung một tên                                                                                                                           |
| S66 | Máy attended: node runtime train mới, lớp UI train cũ                                                      | giao thoa #3                                    | ⚠️→✅ Skew **nội-máy** — không handshake nào của hệ thấy; UI kiểm lúc bắt tay nội-máy và **từ chối chạy**; installer cũng từ chối bộ lệch                                                                                                     |
| S67 | Đang nâng cuốn chiếu fleet server, một node chạm hai server khác train                                     | cluster-run                                     | ⚠️→✅ Tập protocol của fleet = **giao**; bỏ một protocol là hành động **toàn fleet**; cấm vá bằng cách pin node vào một server                                                                                                                |
| S63 | Sau khi bỏ tenant `test`: một test run ghi DataTable rồi bảng production time-travel as-of log-position đó | phase 6 litmus pass                             | ⚠️→✅ **major nhãn `run_kind` không có nhà** — khai hệ quả ở 4 consumer nhưng không ở Event Log ⇒ projection viết sau quên lọc; vá Event Log §1/§3 (nhà canonical + luật "mọi projection khai lập trường") + Calibration §2 + Working Data §1 |
| S62 | Publisher đẩy block class `code` kèm suite riêng để lấy badge verified                                     | vùng mù `unverify × mirror` (khai ở #2), nhóm N | ⚠️→✅ **major vòng tròn "chạy code chưa verified để được verified"** — vá Hub §7 (bằng chứng phụ, test run scope, 0 secret, class `code` chặn bởi spec runtime sandbox)                                                                       |

## Phần 4 — Coverage gaps theo dimension model (vùng mù mới sau full-run #2)

Bốn vùng mù của full-run #1 **đã đóng** (S46, S47, S49 thành finding có vá; S48 accepted). Vùng mù mới khai báo:

`key rotation × evidence/log cũ còn phải đọc được` · `unverify × air-gap mirror (mirror không nhận tín hiệu thu hồi — độ trễ tin cậy)` · `sub-actor hỏng lặp lại × calibration bám filler (mù nguyên nhân?)` · `tenant purge × lockfile/entitlement của block đã mua` · `suspended tenant × node đang giữ session dở`.

**Sau full-run #3** — 3/5 vùng mù trên đã sinh finding có vá (S56 từ `key rotation`, S62 từ `unverify`); 2 vùng còn mở. Vùng mù **mới** khai báo:

`test run scope × time-travel query (bảng production đọc as-of log-position có thấy write của test không?)` · `mirror một chiều × tag release khi private trunk và public mirror lệch nhịp` · `UI attended offline × Action Item đã claim (lease hết TTL khi máy mất mạng)` · `migrations[].down của block × instance đang chạy pin digest cũ` · `environment: test × pool filler của một Role (ai chặn gán sai — engine hay policy?)`.
