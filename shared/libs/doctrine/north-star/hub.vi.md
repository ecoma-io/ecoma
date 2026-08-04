---
title: "Ecoma Hub — North Star"
status: design-end-state
canonical-sha: 10c9ed4db890
---

# Ecoma Hub — North Star

## Trạng thái đích

**Ecoma Hub là hạ tầng đóng gói, phân phối và chia sẻ mọi entity của hệ, dưới
dạng Block: một registry protocol duy nhất (content-addressed, có chữ ký, có
transparency log), một public instance bất biến, N private mirror, và một index
cùng marketplace — nơi cộng đồng nối dài cái đuôi của tri thức quy trình và
publisher đủ sống để bảo trì nó. Hub vắng mặt thì mọi runtime đã cài vẫn chạy,
vĩnh viễn.**

Các nguyên tắc cơ chế mà nó chuyên biệt hóa là canonical ở
[Platform North Star](platform.md) và không được chép lại ở đây.

## Bài toán

"Template" là khái niệm mà default cascade đứng lên, và nó cần một cơ chế phân
phối thật chứ không chỉ một cái tên. App Profile cần một catalog. Cái đuôi dài
của connector và quy trình không thể do một công ty tự viết.

Quyết định hơn cả: **tri thức quy trình là một loại nội dung bị lão hóa.** Ứng
dụng đổi giao diện; quy định đổi. Chia sẻ mà không có kinh tế bảo trì thì sinh ra
một nghĩa địa template từng đúng một lần. Vì thế Hub ghép cơ chế phân phối với
động cơ kinh tế, bởi chỉ một trong hai thứ đó giữ được nội dung sống.

## Nguyên tắc cơ chế

1. **Hub không bao giờ chạm runtime**: không kiểm entitlement lúc chạy, không
   phone-home, không license key trong engine. Thương mại hóa dừng ở tầng phân
   phối — pull và update.
2. **Digest là sự thật; semver là giao diện cho người.** Máy pin digest trong một
   lockfile; người nói tên cộng một khoảng version. Public instance là bất biến:
   thứ đã publish không bao giờ bị xóa, chỉ bị rút khỏi resolve, nên một pin sẵn
   có vẫn chạy được vĩnh viễn — **vĩnh viễn nghĩa là trên engine train đã cài
   nó**. Vượt một engine major là một hành động riêng, có gate: upgrade đọc lại
   mọi pin trong lockfile đối chiếu train mới và nổi lên bất kỳ pin nào mà một
   đường đã bị xóa sẽ làm vỡ _trước_ cutover (Release & Compatibility §3), nên
   "chạy vĩnh viễn" và "các đường deprecated bị xóa ở một major" không đâm nhau
   im lặng.
3. **Không tin publisher.** Tenant chạy lại static analysis lúc cài, và một
   manifest khai ít hơn thứ phân tích phát hiện thì bị reject chứ không phải bị
   cảnh báo. Chữ ký và transparency log chống giả mạo xuyên mirror.
4. **Trust nội dung tái dùng những cơ chế đã có.** Một filler bên trong một block
   khởi động ở tier tin cậy thấp vì nó chưa có calibration trong tenant này; một
   block chứa effect irreversible bị ép sàn bằng một gate. Không có hệ kiểm duyệt
   runtime riêng, bởi một hệ thứ hai sẽ cần bằng chứng riêng và đường khiếu nại
   riêng của nó.
5. **Hub mù trước dữ liệu tenant.** Nó không bao giờ thấy calibration và không
   nhận telemetry nếu không opt-in. Publisher thấy installs và revenue, không gì
   khác.

## Ba tầng

| Tầng            | Nó chứa gì                                                                                     | Ghi chú                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Registry**    | Kho artifact theo chuẩn container: digest, chữ ký publisher, attestation, transparency log     | Bản private là bất kỳ registry sẵn có nào; mirror air-gap dùng lệnh chuẩn                                          |
| **Index**       | Catalog: search, namespace theo publisher và tên, trang block, badge verified, lịch sử version | Namespace sở hữu qua publisher identity, nên squatting được trả lời bằng định danh chứ không bằng việc đi canh tên |
| **Marketplace** | Listing, giá, entitlement, thanh toán, payout revenue-share                                    | Một lớp thương mại mỏng trên index, không phải một hệ riêng                                                        |

Frontend của index và marketplace là một app thuộc domain này, được operator
mount tại edge công khai. Nó render **tĩnh trước hết**, với revalidate do event
của registry kích hoạt — một hệ quả trực tiếp của tính bất biến của nội dung: một
trang cho một version block cache được vĩnh viễn, và chỉ con trỏ mới cần
revalidate.

Có một kênh phát triển song song: block được phát triển trên git, nơi fork và
review cho sẵn lineage và review, còn pack, ký và push mới là hành động phát hành.
Đường thoát — thêm một block thẳng từ một revision git — bị gắn nhãn `unverified`
và tồn tại cho phát triển và dùng nội bộ.

## Một client interface, và chỉ một

Platform và RPA — kể cả RPA standalone — nói với Hub qua đúng ba động từ:
**`resolve` / `pull` / `verify`**. Hub không biết một block chạy thế nào; runtime
không biết một block được lưu hay bán thế nào. Interface và manifest schema được
cấp phép permissive, nên bên thứ ba dựng được một registry tương thích mà không
phải xin ai.

## Cơ chế marketplace

- **Entitlement được kiểm ở đúng một chỗ: phân phối.** Để một subscription hết
  hạn thì mọi thứ đã cài vẫn chạy vĩnh viễn, pin theo digest; thứ mất đi là update
  stream. Đây chính là nguyên tắc 1, nhìn từ phía người mua.
- **Các hình thái giá**: free, one-time (một entitlement vĩnh viễn trong phạm vi
  một major), subscription (quyền pull update stream), và site license.
- **Không DRM.** Một definition là văn bản và copy được. Thứ được bán là update
  stream, phần bảo trì đằng sau nó — một App Profile theo kịp khi giao diện đổi —
  và lòng tin vào một publisher đã verified. Một subscription App Profile chính là
  câu trả lời kinh tế cho câu hỏi "ai bảo trì automation này khi giao diện đổi",
  vốn là câu hỏi giết chết phần lớn các chương trình automation.
- Hai tầng license nội dung: một catalog free theo điều khoản permissive, và block
  trả phí theo điều khoản riêng của publisher, khai tường minh lúc publish.

## Trust và chuỗi cung ứng

- **Publish** là: pack (gồm full static analysis ngay lúc pack), ký, push, index.
  Một Knowledge Collection bên trong một block chỉ được vào public instance ở mức
  classification công khai, nên cửa declassify đứng chắn trước mọi lần publish.
- **Badge verified** được cấp bởi một vòng review vốn tự nó là một workflow Ecoma
  — Hub chạy như một tenant của Platform cho chính việc curation của nó. Kết quả
  là một attestation có chữ ký đính vào artifact.
- **Tự duyệt là bất khả về mặt cấu trúc**, và điều đó quan trọng bởi đây là cửa
  duy nhất cho artifact `code`. Role reviewer khai rằng filler của nó phải khác
  publisher, và operator là người lấp: một publisher không bao giờ lấp Role duyệt
  chính block của mình. Mỗi kết quả là một Judgment có chữ ký, và calibration của
  chính reviewer chịu outcome lan ngược như mọi Role khác.
- **Thu hồi là một event.** Một digest đã ký không bao giờ đổi — nó bất biến —
  nhưng badge rụng, các artifact `code` của publisher đó quay lại mặc định bị
  reject, và index xử như đã rút: pin sẵn có vẫn sống, resolve mới không thấy nó.
- **Conformance suite do publisher cung cấp có những giới hạn cứng.** Một block
  được phép mang suite riêng để chứng minh nó chạy đúng. Ba giới hạn không thương
  lượng: suite là **bằng chứng phụ và không bao giờ là điều kiện đủ** — badge đến
  từ Judgment của một reviewer; suite chạy trong test run scope của operator với
  contract bị cấm toàn phần, không một credential handle nào, và trần thời gian,
  tài nguyên cùng chi phí model; và với trust class `code`, đường review chạy bên
  trong runtime sandbox (Runtime Sandbox §6). Không có nó thì có một vòng tròn:
  muốn được verified thì phải chạy code, mà chạy code lại đòi đã verified. Sandbox
  cắt vòng đó bằng cách biến an toàn thành thuộc tính của cái chuồng, chứ không
  phải của đoạn code đang được duyệt. Cửa verified là cửa duy nhất cho `code`, nên
  chính nó không được trở thành một đường thực thi code chưa duyệt.
- **Artifact `code`** — driver, rule filler tùy biến — là một trust class riêng:
  mặc định bị reject trừ khi publisher đã verified, và chỉ cài được khi admin
  opt-in tường minh, bởi code không phân tích tĩnh kín được như một definition.
- **Cài đặt, phía tenant**: verify chữ ký và log, phân tích lại, **khai lộ scope**
  (nó có chạm effect irreversible không? credential? những domain nào? nó có spawn
  không?) trước khi cài, materialize kèm provenance, cách ly qua các trust tier, và
  ghi vào lockfile.

## Litmus

1. Rút phích Hub — mọi tenant đã cài có còn chạy đủ, vĩnh viễn không?
2. Cùng một block có cài y hệt nhau được từ public instance, từ một private mirror
   và từ một bản air-gap — cùng digest, cùng chữ ký verify được không?
3. Một block có manifest khai thiếu năng lực có bị **reject** lúc cài không, thay
   vì chỉ bị cảnh báo?
4. Nếu một publisher biến mất, người mua có giữ nguyên mọi thứ đã cài không?
5. Hai block mang hai version contract khác nhau có cài cạnh nhau mà không xung
   đột không?
6. Có đường nào để một publisher tự duyệt block của chính mình lấy badge verified
   không? Badge có thu hồi được không, và các artifact `code` của publisher đó có
   mất quyền cài mặc định ngay sau đó không?

## Non-goals

- **Không chạm runtime**; không license key hay phone-home trong engine.
- **Không nhận telemetry mặc định**, không học chéo tenant, và ranking cùng search
  nội bộ của index không bao giờ chạm calibration của tenant.
- **Không phải một hệ CI và không phải một git host.** Phát triển diễn ra ở git;
  Hub nhận những artifact đã pack sẵn.
- **Không đặt chính sách thương mại vào một tài liệu cơ chế** — hoàn tiền và những
  thứ tương tự là vận hành, và đưa chúng vào đây sẽ khiến một tài liệu cơ chế phải
  đổi theo một quyết định kinh doanh.

## Phân phối

- Domain sống trong area riêng của nó. Cấp phép theo luật phân loại canonical ở
  [Platform North Star](platform.md) — protocol `resolve` / `pull` / `verify`,
  manifest schema và client library là những thứ bên thứ ba cắm vào; hub service
  là một thứ để chạy. Tài liệu này không khai lại luật đó, nên không tồn tại nguồn
  thứ hai cho nó.
- Hub gánh dòng doanh thu thứ tư của hệ: **marketplace revenue share.**
