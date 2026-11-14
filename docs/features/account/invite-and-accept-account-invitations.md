# Chấp nhận lời mời tạo Account

> **Feature area:** `account/` · **Mô tả một dòng:** administrator phát lời mời cho một địa chỉ email, người nhận chứng minh quyền sở hữu email bằng OTP và trở thành chủ một Account mới đã xác minh email.
>
> Đặc tả domain → [`domains/account/`](../../domains/account/README.md) · [ADR-0030](../../domains/account/adr/0030-account-creation-channel-invitation.md) · quy tắc viết → [`../README.md`](../README.md).

## 1. Problem

Ngoài administrator bootstrap đầu tiên, tổ chức cần thêm người vào hệ thống. Không có kênh tạo Account có kiểm soát, một người mới không thể có danh tính để đăng nhập, còn nếu cho phép tự đăng ký thì bất kỳ ai cũng tự tạo được tài khoản trong hệ thống nội bộ.

## 2. Outcome

Một administrator được ủy quyền phát lời mời cho một địa chỉ email; người nhận xác minh email bằng OTP qua luồng đăng nhập email-OTP hiện có, và lần xác minh thành công tạo Account mới kèm email `verified` và session dùng được ngay.

- Chỉ administrator có literal `invitation.create` được phát lời mời; phán quyết permission được hỏi từ Staff Access theo từng request, từ chối trả 403, không hỏi được trả 503 fail-closed ([ADR-0033](../../domains/staff-access/adr/0033-permission-verdict-contract.md)).
- Lời mời có thời hạn 7 ngày, một lời mời mở cho mỗi địa chỉ, và địa chỉ `superadmin@ecoma.io` bị loại trừ khỏi kênh lời mời (địa chỉ bootstrap).
- Người nhận chứng minh quyền sở hữu email bằng OTP **trong đúng luồng [Đăng nhập bằng email OTP](../identity/email-otp-sign-in.md)** — không có OTP purpose mới, không có đường xác minh email không xác thực mới. Địa chỉ có lời mời mở và chưa có email `verified` thì nhận được mã thật.
- Lần xác minh OTP thành công tạo Account, email `verified`, và session đã xác thực — tất cả trong một transaction, kèm security event `invitation_account_provisioned`.
- Bảy lý do từ chối đóng (`canonical_address_reserved`, `invitation_already_open`, `invitation_not_open`, `invitation_expired`, `address_already_claimed`, `address_previously_revoked`, `challenge_already_consumed`); mỗi lần từ chối chấp nhận được ghi audit kể cả khi không có chủ thể (subject NULL).
- Phản hồi khi phát lời mời không phân biệt địa chỉ nào đã có Account — anti-enumeration giữ nguyên.
- Phát lời mời là API nội bộ Worker-to-Worker với envelope HMAC; actor lấy từ envelope, không từ body.

## 3. Scope

### Bao gồm

- Phát lời mời: route nội bộ `POST /internal/account/invitations`, đòi verdict `invitation.create`, trả 201; 409 kèm lý do đóng khi bị chặn (`canonical_address_reserved`, `invitation_already_open`, `address_already_claimed`, `address_previously_revoked`).
- Chấp nhận: địa chỉ có lời mời mở + chưa có email `verified` nhận mã thật qua luồng email-OTP; xác minh mã tạo Account + email `verified` + session trong một transaction.
- Lời mời hết hạn, đã dùng, đã bị thu hồi, địa chỉ đã có Account hoặc đã từng bị thu hồi: từ chối một cách an toàn, invitation row vẫn nguyên, không có orphan row, kèm audit từ chối.
- Lỗi rollback: challenge vẫn còn, lời mời vẫn mở, không có hàng mồ côi.
- Server-side authorization trên đường phát: literal `invitation.create` (seed ADR-0033 migration `0010`, cấp cho role `system-administrator`) được hỏi từ Staff Access theo từng request.

### Không bao gồm

- **Phát lời mời chưa có bề mặt operator.** Route phát chỉ là API nội bộ Worker-to-Worker; không có route BFF backoffice, không có trang UI nào phát lời mời (#191 chưa hiện thực). Từ góc operator, bề mặt duy nhất hiện có là gọi API nội bộ trực tiếp; không mô tả API delivery là bề mặt operator hoàn chỉnh (#227 tường minh loại operator UI khỏi phạm vi delivery của nó).
- **Không có self-service signup.** Không có route tự đăng ký nào; Account ngoài bootstrap chỉ sinh từ lời mời.
- **Bootstrap không thuộc Feature này.** Bootstrap tạo Account + administrator đầu tiên qua đường offline tin cậy riêng (ADR-0021, ADR-0024, [ADR-0020](../../domains/staff-access/adr/0020-bootstrap-seed-contract.md)) — địa chỉ bootstrap được loại trừ khỏi kênh lời mời.
- **Không có lời mời tạo identity staff, role hay permission.** Lời mời chỉ tạo Account; identity staff và bổ nhiệm administrator thuộc [Bổ nhiệm và thu hồi administrator](../internal-access/manage-staff-access.md).
- **Không có thu hồi lời mời, không có danh sách lời mời, không có lời mời lại bằng cách phát lại.** Phát lời mời cho địa chỉ đã có lời mời mở trả 409; không có route hủy lời mời.
- **Gửi thư thật chưa được kiểm chứng** — provider giả ở local/system test, mã đọc từ D1 sink (giới hạn chung của luồng email-OTP).

## 4. Acceptance Scenarios

```text
Cho  actor có verdict `invitation.create` cho phép
Khi  phát lời mời cho một địa chỉ chưa có Account
Thì  nhận 201, và địa chỉ đó có một lời mời mở, hết hạn sau 7 ngày
```

```text
Cho  actor không được phép hoặc dịch vụ phán quyết không dùng được
Khi  phát lời mời
Thì  nhận 403 hoặc 503 fail-closed — không lời mời nào được tạo
```

```text
Cho  địa chỉ đã có lời mời mở, hoặc đã có Account, hoặc là địa chỉ bootstrap
Khi  phát lời mời cho địa chỉ đó
Thì  nhận 409 kèm lý do đóng, không lời mời mới nào được tạo
```

```text
Cho  một địa chỉ có lời mời mở và chưa có email đã xác minh
Khi  yêu cầu mã đăng nhập qua luồng email-OTP
Thì  một email chứa mã thật được gửi — ngoại lệ duy nhất của quy tắc "chỉ gửi cho địa chỉ đã xác minh"
```

```text
Cho  người nhận nhập đúng mã OTP trong thời hạn lời mời
Khi  xác minh mã
Thì  Account mới được tạo, email của Account đó ở trạng thái `verified`,
     một session đã xác thực được cấp, và security event `invitation_account_provisioned` được ghi
```

```text
Cho  người nhận nhập sai mã quá giới hạn, hoặc lời mời đã hết hạn, hoặc mã đã dùng
Khi  xác minh
Thì  bị từ chối an toàn: không Account nào được tạo, lời mời còn mở vẫn nguyên, audit từ chối được ghi
```

```text
Cho  địa chỉ đã có Account, hoặc đã từng bị thu hồi email
Khi  xác minh mã với lời mời còn mở
Thì  bị từ chối với lý do đóng; audit từ chối được ghi kèm subject NULL
```

```text
Cho  lỗi database giữa lúc chấp nhận
Khi  transaction rollback
Thì  challenge vẫn còn, lời mời vẫn mở, không có hàng mồ côi nào
```

## 5. Domain & Application Mapping

| Domain / Application                   | Vai trò trong Feature                                                                                                                                        | Canonical                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `account` (bounded context)            | Sở hữu lời mời, Account, email, challenge OTP, session và security event; database `db-account`                                                              | [`domains/account/`](../../domains/account/README.md)                                                            |
| `staff-access` (bounded context)       | Trả phán quyết permission `invitation.create` cho từng request phát lời mời ([ADR-0033](../../domains/staff-access/adr/0033-permission-verdict-contract.md)) | [`domains/staff-access/`](../../domains/staff-access/README.md)                                                  |
| `transactional-mail` (bounded context) | Gửi mã OTP qua template thư đăng nhập                                                                                                                        | [`applications/transactional-mail/01-architecture.md`](../../applications/transactional-mail/01-architecture.md) |
| `apps/account`                         | Deploy unit phục vụ route phát lời mời nội bộ và luồng chấp nhận qua login UI                                                                                | [`applications/account/01-architecture.md`](../../applications/account/01-architecture.md)                       |
| `apps/backoffice`                      | Chưa tham gia — không có route BFF hay UI phát lời mời (#191)                                                                                                | [`applications/backoffice/README.md`](../../applications/backoffice/README.md)                                   |

## 6. Verification Mapping

| Scenario                                                                                   | Test file / suite                                                    | Loại test   | Nx target          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------- | ------------------ |
| Phát lời mời: verdict cho phép → 201; từ chối → 403; dịch vụ phán quyết chết → 503         | `apps/account/tests/integrations/invitations-route-e2e.spec.ts`      | integration | `test-integration` |
| 409 kèm lý do đóng (địa chỉ reserved, đã có lời mời mở, đã claimed, đã revoked)            | `apps/account/tests/integrations/invitations-route-e2e.spec.ts`      | integration | `test-integration` |
| Chấp nhận tạo Account + email verified + session trong một transaction, kèm security event | `apps/account/tests/integrations/invitation-acceptance-e2e.spec.ts`  | integration | `test-integration` |
| Mọi lý do từ chối đóng, không orphan row, audit từ chối subject NULL                       | `apps/account/tests/integrations/invitation-acceptance-e2e.spec.ts`  | integration | `test-integration` |
| Schema lời mời, TTL, index, birth-guard Account                                            | `apps/account/tests/databases/invitations.spec.ts`                   | database    | `test-integration` |
| Lời mời trong challenge: địa chỉ có lời mời mở nhận mã thật                                | `apps/account/tests/integrations/invitation-acceptance-e2e.spec.ts`  | integration | `test-integration` |
| Verdict `invitation.create` phía staff-access: literal đã seed, role được cấp              | `apps/staff-access/tests/integrations/authorization-verdict.spec.ts` | integration | `test-integration` |

**Giới hạn của verification hiện tại:**

- **Không có system test nào chạm đường lời mời** — `identity-login-e2e` chỉ phủ đăng nhập thường. Hành vi end-to-end qua login UI thật chưa có bằng chứng ở tầng người dùng.
- Thư không được gửi ra ngoài ở local/system test (giới hạn chung của luồng email-OTP).
- Sự tồn tại của các spec trên không chứng minh chúng đã chạy và pass. Kết luận `Verified` cần kết quả chạy của `test` và `test-integration`.
