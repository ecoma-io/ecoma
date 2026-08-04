---
title: "Website Charter"
status: design-end-state
canonical-sha: 080408c9bbf0
---

# Website Charter

> **Class tài liệu: System Charter** — cho một hệ mà nhà vận hành chạy, không
> phải một domain sản phẩm. Litmus phân loại: _hệ này có định nghĩa cơ chế mà
> sản phẩm cam kết với tenant không?_ Không — nên nó nhận một charter ở đây,
> không phải một North Star. Vị trí monorepo: area gốc `website/` (convention
> area-first: `apps/ libs/ packages/`), deployment độc lập qua `deploy/`.
>
> Đây là nửa kiến trúc của charter. Nửa còn lại — playbook funnel: chiến lược
> chiến dịch, dây survey, các quyết định tone trước đối thủ — là doctrine của
> nhà vận hành và được giữ kín, đánh dấu rõ trong bảng inventory của corpus
> map. Không điều gì bên dưới phụ thuộc vào nửa đó.

## 1. Vị trí

Mặt tiền thương mại của ecoma.io: nó biến một người lạ thành tenant đã đăng
ký và trao họ cho sản phẩm. Nó không giữ phiên làm việc và không giữ dữ liệu
tenant; nó là cánh cửa, không phải căn phòng.

## 2. Phân loại mạnh — Website vs Hub vs Platform

**Luật một câu**: _Website = mọi thứ **trước danh tính** (thuyết phục người
lạ); Hub = mọi thứ **về block/publisher** (nội dung có digest); Platform tầng
3 = mọi thứ **sau đăng nhập vào công việc**._ Biên URL: **một domain
`ecoma.io`, phân vùng theo path** — `/` (website) · `/blogs` (tuyến nội
dung) · `/hub` (Hub index) · `/app` (product console). **URL ≠ nơi ở của
code** — xem §3.

| Món dễ nhầm                                                                        | Thuộc                                               | Vì sao                                                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Trang "Templates" giới thiệu chung, SEO landing page                               | Website                                             | Thuyết phục, không có digest                                                             |
| Catalog browse/search block, trang chi tiết block, version history, badge verified | **Hub**                                             | Nội dung có digest — nguồn sự thật là registry/index                                     |
| Website muốn show block hot                                                        | Website **nhúng/query từ Hub index**                | **Cấm bản sao**: block đổi mô tả trên Hub → website không có gì phải sửa tay (litmus #6) |
| Publish flow, publisher dashboard, payout                                          | **Hub**                                             | Nghiệp vụ publisher                                                                      |
| Mua block / entitlement / subscription block                                       | **Hub**                                             | Entitlement kiểm tại phân phối                                                           |
| Mua gói SaaS ecoma (pricing → checkout)                                            | Website → control plane                             | Thương mại của _sản phẩm_, không phải của _block_                                        |
| Docs sản phẩm                                                                      | Website                                             | Tài liệu chung                                                                           |
| Docs/README của một block                                                          | **Hub**                                             | Đi theo artifact, theo version của block                                                 |
| Changelog sản phẩm                                                                 | Website                                             | Nhà vận hành phát hành                                                                   |
| Changelog của block                                                                | **Hub**                                             | Theo semver block                                                                        |
| Blog, case study                                                                   | Website                                             | Nội dung thuyết phục                                                                     |
| Inbox, canvas, dashboard                                                           | **Platform tầng 3**                                 | Sau đăng nhập, là sản phẩm                                                               |
| Survey signup/enterprise                                                           | Website (bề mặt) chạy trên **process ecoma**        | Dogfooding, nguyên tắc #1                                                                |
| Status page                                                                        | Website/Trust                                       | Nhà vận hành vận hành                                                                    |
| Storybook, triết lý UI/UX/motion, brand guideline/press kit                        | **`shared/apps/design-system`** mount tại `/design` | Design system là tài sản chung của mọi area — website chỉ link tới                       |

## 3. Một domain, nhiều app độc lập — URL không quyết định nơi ở của code

- **Edge router** (config sống ở `deploy/`) mount các app độc lập vào path:
  `/` → `website/apps/site` · `/hub` → frontend của Hub index · `/app` →
  console của Platform · `/design` → design system dùng chung (SSG theo
  release — khác `/hub` revalidate-theo-event, vì mô hình render là hệ quả
  _nguồn dữ liệu_ của từng hệ). Website là _chủ nhà domain_; các app khác là
  _khách được mount_ — mỗi app vẫn thuộc area của domain sở hữu nó,
  deployment độc lập.
- **Hub frontend ở `hub/`, không bao giờ ở `website/`**: nó render nguồn sự
  thật của Hub (block, digest, publisher, entitlement) và release theo nhịp
  của Hub; chính charter này cấm website chứa bản sao nội dung block (§5);
  SEO đạt bằng mount, không cần chuyển code.
- `/hub` render **tĩnh-first: SSG + revalidate-theo-event** — hệ quả cơ chế,
  không phải lựa chọn framework. Nội dung Hub content-addressed **bất biến**
  → trang một block-version không bao giờ đổi (cache vĩnh viễn); chỉ _con
  trỏ_ (latest/badge/listing) động → registry event (publish/yank/
  attestation) **revalidate đúng trang bị ảnh hưởng**, on-demand — không
  rebuild toàn site, không render-per-request cho nội dung không đổi.
  Search/phần sống = client/edge.
- **Điều kiện an ninh khi share domain** (bắt buộc; hỏng một điều là `/app`
  rơi về subdomain riêng): cookie scope theo path · CSP tách theo route ·
  **third-party script (ads/analytics) chỉ nạp trên route marketing, không
  bao giờ trên `/app`**.

## 4. Nguyên tắc

1. **Dogfooding tuyệt đối**: website chạy trên chính ecoma dưới một growth
   tenant của nhà vận hành — landing = Channel, signup = form Trigger,
   survey = process với external filler, provisioning gọi control plane.
   Funnel là demo sống của sản phẩm và là case study đầu tiên của chính nó.
2. **Zero tenant-data**: không bao giờ đọc dữ liệu tenant nào ngoài
   growth-tenant của chính nó; nói với sản phẩm **chỉ qua API công khai** —
   gọi, không vá.
3. **Deploy độc lập**: static/edge + BFF mỏng, nhịp release riêng qua
   `deploy/`; website sập → product mọi tenant nguyên vẹn.
4. **Consent-first**: visitor = **party ẩn danh** (cookie/device),
   classification mặc định `confidential`; signup = **self-assertion** hợp
   nhất danh tính (tự nhận mình — không cần Gate, khác merge-2-người-lạ);
   quyền được quên = crypto-shredding như mọi party.
5. **Clickstream qua tier ingest**: sự kiện khối-lớn-giá-thấp đi đường
   sampling/batch — không phình Event Log lao động. **Quyền được quên phủ cả
   tier này**: dữ liệu tier key theo party-key shred được, hoặc
   ẩn-danh-hóa-không-thể-đảo + TTL ngắn mặc định.

## 5. Non-goals

- Không phải analytics platform bán cho tenant (đó là một block trên Hub;
  website chỉ là _người dùng đầu tiên_ của nó).
- Không hệ auth riêng — dùng Principal/Party của sản phẩm.
- **Không lưu bản sao nội dung block** — chỉ nhúng/link từ Hub index.
- Không chạm runtime tenant; không A/B bằng cách vá product.
- Không host docs-per-block.

## 6. Litmus

1. Rút `website/` — product mọi tenant chạy bình thường, chỉ mất trang bán
   hàng?
2. Mọi survey response truy được provenance như task output (contract nào,
   khi nào)?
3. Visitor ẩn danh đòi quên — một lệnh hủy khóa, hết đọc được?
4. Website đọc được dữ liệu tenant nào ngoài growth-tenant? (bắt buộc:
   không)
5. Ads tăng 100× traffic — Event Log lao động không phình theo?
6. Một block đổi mô tả/version trên Hub — website không có bản sao nào phải
   sửa tay?
7. Trang một block-version sau publish **không bao giờ cần render lại** (bất
   biến); đổi "latest" chỉ revalidate đúng các trang bị ảnh hưởng?

## 7. Nhật ký quyết định

| Vấn đề                 | Chốt                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vị trí kiến trúc       | Area gốc `website/` (`apps/ libs/ packages/`), deploy độc lập — System Charter, không phải domain dọc                                                                                                                                                   |
| Ranh giới với Hub      | Luật một câu §2 + cấm bản sao nội dung block                                                                                                                                                                                                            |
| Chạy trên gì           | Chính ecoma, dưới một growth tenant — dogfooding là nguyên tắc #1                                                                                                                                                                                       |
| Visitor identity       | Party ẩn danh + self-assertion khi signup                                                                                                                                                                                                               |
| Clickstream            | Tier ingest (sampling/batch) trước Event Log, kèm phủ quyền-được-quên                                                                                                                                                                                   |
| URL topology           | Một domain `ecoma.io`, path-based (`/blogs`, `/hub`, `/app`) — subfolder gom SEO authority; `/app` noindex; share domain chỉ đứng trên 3 điều kiện an ninh §3, không đạt thì `/app` về subdomain                                                        |
| Nơi ở của Hub frontend | Ở `hub/` — code theo domain sở hữu, không theo URL; mount qua edge (config ở `deploy/`)                                                                                                                                                                 |
| Render `/hub`          | SSG + revalidate-theo-registry-event — hệ quả tính bất biến của nội dung Hub                                                                                                                                                                            |
| `/design`              | Design system dùng chung mount qua edge; SSG theo release; chứa triết lý thiết kế + brand guideline/press kit                                                                                                                                           |
| Brand voice & tone     | Canonical ở `/design` (brand guideline); blog/website tuân theo — một nguồn giọng nói                                                                                                                                                                   |
| Support chatbot        | Channel chat-widget của growth tenant; KB ingest từ chính git/website của sản phẩm với source binding, classification `public`; mọi câu trả lời trích chunk@commit-hash — demo sống cho kịch bản RAG và khách đầu tiên của một block knowledge-from-git |
