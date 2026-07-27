---
name: repo-care
subsystem: shared
lang: vi
description: Tự động hoá bề mặt repository — phân loại issue, review PR cố vấn theo doctrine, và dịch thread, qua các LLM miễn phí.
---

> 🌐 [English](./README.md) · **Tiếng Việt** · [中文](./README.zh.md)

# repo-care

<!-- readme:why -->

Ba việc trên GitHub cần phán đoán ngôn ngữ tự nhiên mà một gate xác định
(deterministic) không làm được: phân loại type/area cho issue mới, soi
một PR xem có vi phạm doctrine ở lớp phán đoán mà không lint nào bắt được
(test bị làm yếu đi, một stub giả vờ xong việc, một refactor lén trà trộn),
và soi chiếu một thread viết bằng một ngôn ngữ của dự án sang hai ngôn ngữ
còn lại để không ai bị đứng ngoài cuộc thảo luận.
`repo-care` giao cả ba việc này cho LLM, nhưng chỉ qua tầng free không cần
key của opencode zen (`https://opencode.ai/zen/v1`) — không API key, không
secret cần cấp phát. Các model free riêng lẻ yếu và chập chờn (rate-limit
hay provider sập trả về HTTP 200 kèm `error` body, không phải một mã lỗi
sạch), nên toàn bộ thiết kế không tin lời một model duy nhất: `zen.mjs` gom
tối đa 3 verdict đã qua schema validation cho mỗi câu hỏi, chỉ hành động khi
≥2 verdict đồng ý (`tallyVerdicts`); không đủ 2 verdict khả dụng là thoát với
mã lỗi (fail loud), không bao giờ tung đồng xu. Lớp chắn còn lại là enum:
model chỉ được chọn trong một vocabulary cố định (`TYPES`, `AREAS`,
`LABEL_DEFS`, `CHECKS`), giới hạn thiệt hại của một model chập chờn hay bị
prompt-injection còn "gắn nhầm một nhãn có sẵn trong danh sách".

Dịch thuật là chỗ duy nhất mà văn xuôi tự do đi ra từ một model, nên nó cũng
là ngoại lệ duy nhất — một ngoại lệ hẹp và có chủ đích. Việc nhận diện thread
đang viết bằng ngôn ngữ nào vẫn là chọn trong enum, nên vẫn cần đủ quorum.
Còn bản dịch thì không thể đem ra kiểm phiếu, nên nó được khoanh vùng thay vì
bỏ phiếu: bản dịch nằm trong một comment cộng thêm có `TRANSLATE_MARKER`,
không bao giờ sửa tiêu đề hay body của chính tác giả, và `sanitizeTranslation`
vô hiệu hoá mọi thứ trong đó có thể hành động thay vì chỉ để đọc.

<!-- readme:consumers -->

Ba workflow GitHub Actions gọi trực tiếp tool này, cả ba đều dùng
`GITHUB_TOKEN` sẵn có (không cần secret riêng):
`.github/workflows/issue-triage.yml` chạy `main.mjs triage-issue` khi issue
`opened`/`reopened` (thêm `workflow_dispatch` thủ công để triage lại issue
cũ); `.github/workflows/pr-doctrine-review.yml` chạy `main.mjs review-pr`
trên PR non-draft `opened`/`reopened`/`synchronize`/`ready_for_review`;
`.github/workflows/thread-translate.yml` chạy `main.mjs translate-issue` hoặc
`main.mjs translate-pr` khi issue và PR `opened`/`edited`. Không
workflow nào được nối vào required/branch-protection checks — xem
`readme:boundary`.

<!-- readme:ecosystem -->

`repo-care` là tool anh em của `dev-cli` và `eslint-local-rules` trong
`shared/tools`: `dev-cli` gate mã nguồn và quy ước repo, `eslint-local-rules`
gate AST, còn `repo-care` tự động hoá bề mặt repository (issue, PR) quanh
chúng. Nó không tự viết ra vocabulary của mình — enum `AREAS` cho triage-
issue được dẫn xuất tại thời điểm import từ frontmatter của mọi `README.md`
subsystem-root (hợp đồng do `dev-cli check-subsystem-readmes` giữ trong CI),
rubric `CHECKS` cho review-pr được dẫn xuất từ `diffCards`/`pathCards` trong
`doctrine-index.json` (do `dev-cli check-doctrine-index` giữ), còn danh sách
ngôn ngữ để dịch đến từ `languages.config.json` ở gốc repo — đúng file mà
`dev-cli` đọc cho hợp đồng README đa ngữ, nên hai bên không thể nào gọi tên
hai bộ ngôn ngữ khác nhau. Cả ba vẫn là
một nguồn sự thật duy nhất được đọc lúc chạy, không bao giờ viết lại hay chép
vào project này.

<!-- readme:boundary -->

`review-pr` chỉ là cố vấn theo định nghĩa, không bao giờ là một gate bắt
buộc hay chặn merge — kết quả xanh/đỏ của các gate xác định
(lint/test/typecheck/build) mới là nguồn sự thật duy nhất quyết định PR merge
được hay không. Model ở đây không bao giờ thực thi bất cứ gì và không bao giờ
tự bịa nhãn: mọi trường verdict phải đến từ một enum cố định, và các lần đọc
repository trong review-pr đều được validate, giới hạn ngân sách, và chỉ đọc
(mã nguồn của chính tool này đọc từ base ref đáng tin, nội dung diff/file đọc
từ head SHA của PR, luôn được đóng khung như dữ liệu không đáng tin). Dịch
thuật cũng cộng thêm theo đúng tinh thần đó: nó chỉ đăng hoặc sửa comment
`TRANSLATE_MARKER` của chính nó — tiêu đề và body của tác giả không bao giờ bị
viết lại, và comment của một job anh em thì nằm ngoài tầm với, vì mọi lần tra
cứu ở đây đều neo marker bằng `startsWith`.
`repo-care` cũng không có `package.json` và không bao giờ được import — nó
chạy trên `node` trần để các job GitHub Actions không cần `pnpm install`.

<!-- readme:status -->

Đang hoạt động thật: cả ba workflow chạy tool này trên mọi sự kiện GitHub
khớp điều kiện, không phải bản nháp hay một seam chưa nối. Mechanics — luật
quorum/tally verdict, các vocabulary enum, quy trình điều tra nhiều lượt của
review-pr, ngoại lệ quorum của phần dịch, và các cạm bẫy đã biết — nằm ở
[`./CLAUDE.md`](./CLAUDE.md).
