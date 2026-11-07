# ADR-0005 — Step-up mechanism: fresh session ≤ 5 phút trước privileged operation

> 📌 Thư mục này là bounded context **Staff Access** (xem [`../README.md`](../README.md) §4): ADR này chốt quyết định cho nghiệp vụ staff/RBAC khi được tách khỏi `backoffice` (A21–A24). Ngày nay `backoffice` còn sở hữu staff/RBAC.

> **Trạng thái:** Accepted · **Ngày:** 2026-10-21 · **Quyết định từ:** [`domain-model.md`](../domain-model.md) §9 (hàng 5), §6 · **Issue:** #87

## Bối cảnh

§6 chốt "Permission ≠ authentication assurance": một staff member có permission vẫn có thể bị đòi xác thực lại (step-up) cho hành động rủi ro cao, và `backoffice` chỉ tin bằng chứng từ flow `auth` đáng tin cậy — không bao giờ tin cờ MFA do client supply (SR-017, T-07). Câu hỏi §9: cơ chế step-up là gì và cửa sổ freshness dài bao lâu.

Ràng buộc nền tảng: xác thực (credential/MFA/passkey, browser session) thuộc `account`/`auth`; `backoffice` không nhân bản state này (§2). Bằng chứng step-up vì vậy **phải** quay về bằng chứng xác thực đã cấp gần đây từ `account`/`auth` — `backoffice` không thể tự bắt staff nhập mật khẩu/mã OTP thứ hai vì nó không giữ credential.

## Phương án

| #   | Phương án                                                                                            | Đánh giá                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Fresh-session window: privileged operation chỉ chạy khi session được authn lại ≤ 5 phút trước đó** | Chấp nhận — bằng chứng nằm ở `account`/`auth`, `backoffice` chỉ kiểm tuổi của bằng chứng đó                                                                                                                |
| 2   | `backoffice` tự thu thập mật khẩu/MFA thứ hai                                                        | Loại — biến `backoffice` thành credential collector hay IdP thứ hai, vi phạm §2                                                                                                                            |
| 3   | Cờ `mfa: true` do client gửi                                                                         | Loại — SR-017 cấm tin cờ do client supply; T-07                                                                                                                                                            |
| 4   | Re-auth bắt buộc cho **mỗi** privileged operation                                                    | Loại — cản trở vận hành không cân xứng: nhiều privileged op liên tiếp trong một phiên làm việc là bình thường, và đòi step-up từng thao tác tạo chi phí xác thực lặp lại mà không giảm thêm rủi ro đáng kể |
| 5   | Không step-up — permission là đủ                                                                     | Loại — security posture yếu hơn yêu cầu "thao tác rủi ro cao cần phê duyệt độc lập" của §6                                                                                                                 |

## Quyết định

**Step-up = yêu cầu session đã được xác thực lại (re-auth) trong vòng ≤ 5 phút trước privileged operation; bằng chứng lấy từ flow `auth`/`account` đáng tin cậy, không từ client.**

- **Mechanism:** một privileged operation đòi step-up chỉ thực thi khi `backoffice` xác minh được bằng chứng xác thực với thời điểm authn (`auth_time` hay tương đương do `auth` cấp) **≤ 5 phút** trước thời điểm thao tác. Nếu bằng chứng cũ hơn, `backoffice` điều hướng qua bước re-auth ở `account`/`auth` rồi mới tiếp tục; không có đường chấp nhận cờ từ client.
- **Ngưỡng 5 phút là target** cho cửa sổ freshness privileged operation — không phải TTL session chung của `account` (TTL session thuộc `account`, không thuộc `backoffice`). Thay đổi ngưỡng phải qua ADR mới, không tweak trong code.
- **Bằng chứng chỉ từ trusted `auth` flow** (SR-017): thời điểm authn được `auth` mang trong token/id_token đã ký; `backoffice` verify token bằng JWKS ES256 của `auth` như mọi token khác, không tự parse hay tự suy freshness từ dữ liệu client.
- **Không tin MFA flag do client supply** — claim/header/body mang `mfa: true`/`assurance` từ client bị bỏ qua (SR-001, SR-017).
- **Danh sách privileged operation cần step-up** do workstream B liệt kê trong domain/catalog (gán role, mass edit, recovery…), không nằm ở ADR này; điều chốt là mọi thao tác được đánh dấu privileged operation rủi ro cao phải đi qua fresh-session check này.
- **Không tạo bước step-up riêng dựa trên mật khẩu do `backoffice` giữ** — mọi re-auth đi qua flow chuẩn của `account`/`auth` (credential/MFA/passkey của nó).

## Hệ quả

- `account`/`auth` phải expose được thông tin authn-time trong token/bằng chứng mà `backoffice` validate được (OIDC `auth_time` là chuẩn sẵn; cân nhắc ACR/amr cụ thể do workstream xác định).
- Staff member làm nhiều privileged op liên tiếp trong 5 phút không phải re-auth mỗi lần — một re-auth phục vụ được nhiều thao tác trong cửa sổ; cửa sổ hết thì thao tác sau bị yêu cầu re-auth lại.
- UI không tự coi mình là chốt chặn: nếu staff ở trạng thái không đủ fresh, UI ẩn/hiển thị CTA step-up nhưng quyết định là của server (UI visibility ≠ authorization — §4).
- Con số 5 phút là target được hiện thực bởi workstream B; nếu cơ chế thực tế không đạt được ngưỡng này thì phải xem lại bằng ADR mới, không âm thầm nới cửa sổ.

## Cross-reference

- **SR/T-**: SR-017, SR-008, SR-001 · T-07 ([`applications/staff-access/02-requirements.md`](../../../applications/staff-access/02-requirements.md)).
- **Thiết kế:** [`domain-model.md`](../domain-model.md) §5, §6 · §9 (hàng "Step-up mechanism").
- **System:** [`architecture/01-architecture.md`](../../../architecture/01-architecture.md) §6 "Shared-origin `ecoma.io/*`: thao tác nhạy cảm cần step-up auth" · A22.
- **Implementation:** #86 (Workstream B).
