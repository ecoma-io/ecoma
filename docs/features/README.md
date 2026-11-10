# Features

> **Phạm vi:** view Features trong bốn view tri thức của [`engineering/evolution-process.md`](../engineering/evolution-process.md) §3 — vấn đề người dùng, outcome sản phẩm, phạm vi capability, acceptance scenario, domain/application tham gia và test verify.
>
> **Không thuộc tài liệu này:** kiến trúc hệ thống → [`architecture/`](../architecture/README.md) · trách nhiệm và invariant của bounded context → [`domains/`](../domains/README.md) · thiết kế application/deploy unit → [`applications/`](../applications/README.md) · schema API/contract → machine-readable contract · trạng thái capability → suy ra theo [`evolution-process.md`](../engineering/evolution-process.md) §5, không lưu ở đây.

## 1. Mục đích

Feature document trả lời một câu hỏi mà domain specification và API reference không trả lời: **người dùng gặp vấn đề gì, và hệ thống tạo ra kết quả gì cho họ.**

Nó tồn tại để developer, product owner và coding agent hiểu nhanh một capability ở mức sản phẩm trước khi đọc sâu vào domain hay code. Nó **không** giải thích cách hiện thực, không định nghĩa contract và không lập kế hoạch.

Một Feature document gồm đúng sáu phần, theo [`_template.md`](./_template.md):

| Phần                         | Trả lời                                             |
| ---------------------------- | --------------------------------------------------- |
| Problem                      | Người dùng gặp vấn đề gì, trong tình huống nào      |
| Outcome                      | Hệ thống cung cấp kết quả gì cho họ                 |
| Scope                        | Feature bao gồm và **không** bao gồm những gì       |
| Acceptance Scenarios         | Những hành vi quan trọng nhất có thể kiểm chứng     |
| Domain & Application Mapping | Domain và application nào tham gia, sở hữu phần nào |
| Verification Mapping         | Test nào kiểm chứng scenario nào, ở tầng nào        |

## 2. Feature khác Domain, Application và backlog như thế nào

Bốn view có thể cùng mô tả một vùng hệ thống, nhưng từ bốn góc khác nhau. Nhầm góc là nguồn gốc của tài liệu trùng lặp và lệch.

| View             | Câu hỏi của nó                                                     | Không sở hữu                                          |
| ---------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| **Features**     | Người dùng cần gì, hệ thống cho ra kết quả gì                      | Rule, invariant, contract, cách hiện thực, thứ tự làm |
| **Domains**      | Ai sở hữu trách nhiệm nghiệp vụ nào, rule và invariant là gì       | Vấn đề người dùng, topology, code structure           |
| **Applications** | Application/deploy unit nào hiện thực, ranh giới và runtime ra sao | Định nghĩa contract, trách nhiệm nghiệp vụ            |
| **Architecture** | Hệ thống tổ chức ra sao, ràng buộc nào áp dụng                     | Domain model, thiết kế application                    |

Ba hệ quả thực hành:

- **Feature không phải domain spec.** Nếu một câu trong Feature document nhắc lại một invariant hoặc một state machine, câu đó thuộc `domains/`. Feature chỉ nêu outcome và trỏ tới nơi canonical.
- **Feature không phải API reference.** Endpoint, header, payload và status code thuộc machine-readable contract. Feature nêu hành vi người dùng quan sát được, không chép schema.
- **Feature không phải backlog.** Không có status, phase, issue, PR, roadmap hay checklist. Việc còn thiếu nằm ở mục **Scope → Không bao gồm** dưới dạng giới hạn phạm vi, và công việc nằm trên GitHub.

## 3. Tổ chức thư mục

Mỗi thư mục con là một **feature area**, không phải một Nx project hay một bounded context. Một area có thể chạm nhiều domain và nhiều application; một domain có thể xuất hiện trong nhiều area.

```text
docs/features/
  README.md                  # tài liệu này — mục đích, cách tổ chức, quy tắc
  _template.md               # cấu trúc bắt buộc của một Feature document
  public-website/            # homepage public đa ngôn ngữ
  identity/                  # đăng nhập và truy cập application qua OIDC
  account/                   # self-service của chủ tài khoản
  internal-access/           # truy cập tài nguyên nội bộ được bảo vệ
  pact-broker/               # contract testing giữa consumer và provider
  remote-cache/              # build cache theo project cho Nx
```

Quy tắc đặt tên: tên file là một cụm động từ + đối tượng mô tả outcome (`manage-profile-and-emails.md`), không phải tên endpoint hay tên bảng.

## 4. Index

### Public website

- [Duyệt homepage public đa ngôn ngữ](./public-website/browse-localized-public-content.md) — homepage public bằng tiếng Việt hoặc tiếng Anh, trên URL locale ổn định `/en`·`/vi` với redirect từ `/`.

### Identity

- [Đăng nhập bằng email OTP](./identity/email-otp-sign-in.md) — nhận và xác thực mã OTP qua email, tạo browser session.
- [Truy cập application qua OIDC](./identity/oidc-application-access.md) — Authorization Code Flow với PKCE, consent, token và refresh token.

### Account

- [Quản lý profile và email](./account/manage-profile-and-emails.md) — xem/cập nhật profile, thêm và xác minh email.
- [Quản lý tuỳ chọn cá nhân](./account/manage-personal-preferences.md) — locale, timezone, giao diện và tuỳ chọn thông báo.
- [Quản lý session đang hoạt động](./account/manage-active-sessions.md) — xem và thu hồi session của chính mình.
- [Gửi yêu cầu về quyền riêng tư](./account/submit-privacy-requests.md) — tạo và theo dõi privacy request.

### Internal access

- [Truy cập tài nguyên nội bộ được bảo vệ](./internal-access/access-protected-staff-resources.md) — staff đăng nhập và truy cập tài nguyên theo permission.

### Pact Broker

- [Publish và truy xuất contract](./pact-broker/publish-and-retrieve-contracts.md) — consumer publish pact, provider đọc contract.
- [Verify contract và gate deployment](./pact-broker/verify-contracts-and-gate-deployments.md) — ghi verification result, xem matrix, `can-i-deploy`.
- [Quản lý machine credential của Pact Broker](./pact-broker/manage-pact-broker-machine-credentials.md) — tạo, xoay vòng và thu hồi credential cho CI.

### Remote cache

- [Build cache theo project](./remote-cache/project-scoped-build-cache.md) — chia sẻ cache artifact giữa các lần chạy Nx, cách ly theo project.

## 5. Ranh giới với trạng thái

Feature document **không** mang trạng thái. Một tài liệu mô tả capability đã có implementation trong repository, nhưng điều đó **không** có nghĩa capability đã verified hay đã released. Bốn trạng thái `Specified` · `Implemented` · `Verified` · `Released` là bốn tuyên bố độc lập, mỗi tuyên bố cần bằng chứng riêng, và được suy ra theo [`evolution-process.md`](../engineering/evolution-process.md) §5.

Hệ quả cho người viết và người đọc:

- **Mục Scope → Không bao gồm** ghi giới hạn đã biết (chưa hiện thực, chỉ là prototype, đang dùng mock). Đây là mô tả phạm vi, không phải danh sách việc cần làm.
- **Verification Mapping** nêu test **sẽ** kiểm chứng scenario và tầng của nó. Sự tồn tại của một test file không chứng minh test đó đã chạy và pass; muốn kết luận `Verified` phải có kết quả chạy của target tương ứng.
- **Released** cần deployment record và kiểm tra environment sau deploy. Repository hiện chưa có deployment record cho capability phục vụ production, nên không Feature document nào được suy ra `Released` từ việc source đã merge.
