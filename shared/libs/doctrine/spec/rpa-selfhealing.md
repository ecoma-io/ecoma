---
title: "Ecoma RPA Spec: Self-healing"
status: design-end-state
lang: vi
---

# Ecoma RPA Spec: Self-healing

## 1. Executor — hai đầu một trục

|                  | Script                                                                            | Agent                                                               |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Là gì            | Chuỗi action tổng quát hóa từ action log (Session §5), locator nghiêng structural | Vision model + intent, locator nghiêng semantic                     |
| Chi phí / tốc độ | ~0 / nhanh                                                                        | Cao / chậm                                                          |
| Độ bền UI đổi    | Thấp                                                                              | Cao                                                                 |
| Danh tính        | id + version + **lineage**                                                        | (model, version, config_hash) + lineage — y hệt Filler bên Platform |

Executor của một automation là **một dial, không phải một lựa chọn nhị phân**: từng action có thể chạy bằng tầng locator khác nhau (Driver spec §4).

## 2. Vòng healing (script → agent → script)

```
script fail (locator cạn tầng 1–2, hoặc precondition lệch)
 → agent tiếp quản đúng action đó: resolve bằng tầng 3–4, thực thi theo intent
 → thành công → phát PATCH: anchor structural mới học từ kết quả tầng 4
 → script version mới, parent = version cũ (lineage, kế thừa tin cậy có decay)
```

- **Cửa duyệt patch tỉ lệ theo reversibility** (phức tạp là lựa chọn, mặc định an toàn):

| Lớp action được vá    | Mặc định                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `read` / `reversible` | Auto-apply, ghi log                                                                                         |
| `compensable`         | Auto-apply + cờ chờ hậu kiểm                                                                                |
| `irreversible`        | **Chờ duyệt** — tích hợp: là một Gate (Checkpoint) đúng nghĩa; standalone: confirmation qua consumer nội bộ |

- Healing thất bại (tầng 4 cũng không resolve) → escalate; tích hợp thì theo chuỗi Escalation của Task.

## 3. Chiều ngược: distillation (agent → script)

Automation chạy thuần agent nhưng **ổn định lặp lại** (cùng chuỗi action, cùng phân phối tầng-thắng qua N phiên): engine đề xuất **compile thành script** — giảm chi phí ~vài bậc, giữ semantic intent trong locator làm lưới an toàn. Chấp nhận đề xuất = script mới có lineage từ agent identity. Kết quả: automation **tự trưởng thành về phía rẻ**, tự lùi về phía bền khi môi trường động — trục hai chiều khép kín.

## 4. Tin cậy của version vá — không có đặc quyền

- Script version mới = identity mới có lineage → **khi tích hợp, đi qua trust tiers của Platform như mọi Filler** (kế thừa calibration cha với decay; nếu policy đòi, chạy shadow bằng dry-run trước khi thay cha). Không có "vá là được tin ngay".
- **Decay theo bản chất patch** (tham số template): chỉ-đổi-locator, hành vi giữ nguyên → decay ~0; đổi hành vi/chuỗi action → decay lớn. Shadow dry-run so sánh với primary bằng **action-log diff** — criteria định nghĩa trên log, vì artifact của RPA chính là log + effects.
- **Filler đăng ký với Platform = automation** (script@version + healing policy, hoặc agent config): chuyển giao script⇄agent theo từng action là hành vi _bên trong_ filler, ghi **sub-actor** trong log. Calibration Platform bám filler đăng ký; ML chi tiết dùng sub-actor.
- Standalone: trust cục bộ tối giản = bảng cửa duyệt §2 — vẫn cùng nguyên lý, ít nấc hơn.

## 5. UI drift smell — healing là dữ liệu học

Mỗi sự kiện healing ghi: (locator, tầng fail, tầng thắng, patch, app fingerprint). Từ đó:

- **Cùng locator heal lặp lại** → phần tử bất ổn định → đề xuất nâng cấp locator trong App Profile (vá gốc, không vá ngọn).
- **Nhiều locator cùng app heal đồng loạt + fingerprint đổi** → app đổi version → đề xuất App Profile version mới (một lần, cho mọi automation dùng app đó — sửa 1 chỗ, lành N script).
- Khi tích hợp: các đề xuất này đi vào Platform như đề xuất của tầng Intelligence — qua vòng pair-design (Composition §5), có Gate, có Judgment. **RPA không tự sửa tri thức dùng chung ở runtime** — nhất quán với Action spec §4.

## 6. Non-goals

- Không heal ngữ nghĩa nghiệp vụ ("form đổi thêm trường bắt buộc mới") — đó là thay đổi quy trình, escalate cho pair-design, không phải vá locator.
- Không auto-apply patch cho action irreversible trong bất kỳ cấu hình mặc định nào.

## 7. Nhật ký quyết định

| Vấn đề          | Chốt                                                                               |
| --------------- | ---------------------------------------------------------------------------------- |
| Script vs agent | Hai đầu một trục trên semantic locator; chuyển giao theo từng action               |
| Patch           | Version mới có lineage; cửa duyệt tỉ lệ reversibility; irreversible luôn chờ duyệt |
| Chiều ngược     | Distillation agent→script khi ổn định — trục hai chiều                             |
| Tin version vá  | Đi qua trust tiers Platform, không đặc quyền                                       |
| Học từ healing  | Drift smell → đề xuất App Profile qua vòng duyệt, không tự sửa runtime             |

## Litmus (spec-level, theo L5)

1. Patch cho action `irreversible` có đường nào auto-apply trong bất kỳ cấu hình mặc định nào?
2. Script vá xong có được tin ngay không, hay phải đi qua trust tiers với decay theo bản chất patch?
3. Healing của một tenant có đường nào chảy sang tri thức dùng chung (App Profile catalog) mà không qua opt-in + vòng duyệt?
