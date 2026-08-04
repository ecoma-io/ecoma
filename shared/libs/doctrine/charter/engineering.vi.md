---
title: "Engineering & Delivery Charter"
status: design-end-state
canonical-sha: 0aef578e29be
---

# Engineering & Delivery Charter

Nửa công bố của hệ thống giao hàng thuộc workspace này: mã đi từ một commit
đến một artifact đã ký như thế nào. **Một charter mô tả một trạng thái
đích.** Phần lớn nội dung sau đây đã được thiết kế nhưng chưa xây — đó là
tình trạng bình thường của một charter, và chính roadmap, không phải tài
liệu này, nói khi nào từng mảnh xuất hiện. Đọc nó như mô tả những gì đang
chạy hôm nay là một lỗi phân loại; đọc nó như hình dạng mà mọi cơ chế ở đây
phải lớn lên thành là cách dùng đúng.

Hai nửa bị cố ý bỏ qua, mỗi nửa vì một lý do riêng. Thứ đã ràng buộc một
contributor — quy ước commit, định nghĩa hoàn thành, các tầng test, luồng
pull request — sống ở `CONTRIBUTING.md` và `CLAUDE.md` gốc, nơi nó đến tay
contributor một cách tự động; nhắc lại ở đây sẽ là một bản sao thứ ba tự do
trôi dạt. Thứ liên quan đến workspace control-plane riêng tư — CI của nó,
credential của nó, nhịp thương mại — nằm trong playbook giao hàng (không
công bố), vì nó chi phối một repository mà repository này không tham chiếu
tới.

> **Class: System Charter.** Nó không định nghĩa cơ chế sản phẩm nào cam kết
> với tenant, nên nó không phải một North Star; nhưng nó **bị ràng buộc một
> chiều bởi các cơ chế sản phẩm** — unified release train, protocol-version +
> handshake, migration-as-entry, phân phối node qua Hub, và các gate ◆G như
> freeze + conformance suite. Charter có thể đổi tự do; cơ chế của trần thì
> không. Xung đột giải quyết theo hướng có lợi cho trần.

## 1. Vị trí & phạm vi

Trong phạm vi: **nhánh · CI · quality gate · cắt release · publish**.

Ngoài phạm vi: deploy và vận hành hạ tầng ([deploy charter](./deploy.md)),
thương mại artifact ([Hub](../north-star/hub.md)), và cơ chế versioning của
sản phẩm ([Platform NS](../north-star/platform.md) §8 — charter này chỉ
_thực thi_ nó).

Luật biên tập đằng sau các loại trừ đó:

| Nếu luật…                                         | Nhà của nó                                                    | Charter này                     |
| ------------------------------------------------- | ------------------------------------------------------------- | ------------------------------- |
| đã ràng buộc contributor hôm nay                  | `CONTRIBUTING.md` · `CLAUDE.md` gốc · các gate thực thi chúng | **chỉ trỏ tới, không nhắc lại** |
| là một cơ chế sản phẩm                            | trần (North Star / spec)                                      | thực thi, không lập pháp        |
| là thiết kế đã chốt nhưng chưa có cỗ máy nào chạy | **ở đây**                                                     | nhà duy nhất                    |

Một nhà thứ ba cho một luật là một bản sao thứ ba tự do trôi dạt: khi hai
nhà bất đồng, không có cách nào biết cái nào ràng buộc.

## 2. Nhánh — trunk-based

| Quy ước                               | Nội dung                                                                                                                                                    | Lý do                                                                                                                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Một trunk** (`main`), luôn xanh     | Nhánh sống ngắn tách từ trunk, merge bằng pull request; không nhánh area hay domain sống dài                                                                | Hệ quả trực tiếp của unified release train: một tag `X.Y.Z` cắt _mọi_ artifact, và nhánh per-area sống dài kéo ba domain của một monorepo trôi xa nhau. Gitflow bị bác bỏ vì cơ chế, không vì gu                                                 |
| **Nhánh release chỉ cắt lúc release** | `release/X.Y` tách khỏi trunk tại điểm cắt; hotfix được sửa trên trunk rồi cherry-pick sang nhánh release, không bao giờ sửa xuôi trên nhánh                | Trunk giữ vai trò nguồn sự thật duy nhất cho code                                                                                                                                                                                                |
| **Tính năng chưa xong**               | Merge sớm sau một feature flag **build-time hoặc config**                                                                                                   | Ranh giới cứng: một flag không bao giờ trở thành entitlement check, licence key, hay phone-home lúc chạy. Flag là công cụ phát triển và chết lúc build; một flag sống sót đến runtime để gate theo danh tính người mua vi phạm non-goal của trần |
| **Merge queue**                       | Một pull request đã duyệt không merge thẳng: nó xếp hàng, CI chạy lại trên **trunk-sẽ-là** (trunk cộng các pull request đứng trước nó), và chỉ land khi qua | Hai thay đổi đúng riêng lẻ vẫn có thể sai khi gộp lại. Chỉ merge queue bắt được lớp lỗi đó. "Trunk luôn xanh" là _kết quả_ của queue, không phải giả định đi trước nó                                                                            |
| **Một pull request, một ý định**      | Refactor và đổi hành vi không trộn; diff quá khổ bị yêu cầu tách; thay đổi chạm schema mang theo **down-migration trước khi merge**, không bao giờ để nợ    | Đây là điều kiện khiến revert là thao tác rẻ nhất có sẵn — thiếu chúng, "lúc nào cũng revert được" chỉ là một câu nói chứ không phải một năng lực                                                                                                |
| **Revert trước**                      | Trunk đỏ hoặc nghi ngờ drift → **revert trước, điều tra sau**: một thao tác, không cần hiểu nội dung, không đổ lỗi. Bản revert ghi lý do của nó             | Trong trunk-based development, chi phí revert thấp là van an toàn chính, và mọi luật ở trên tồn tại để giữ van đó rẻ                                                                                                                             |

## 3. CI — cơ chế thực thi mọi quality gate, theo ba tầng tốc độ

Tốc độ và an toàn không đánh đổi nhau; chúng được phân tầng. _Nhanh ở pull
request, chặt ở queue, đầy đủ theo nhịp._

| Tầng                     | Khi nào                    | Chạy gì                                                                                   | Ngân sách                  |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- |
| **Pull request**         | mỗi lần push               | build và test **theo area bị ảnh hưởng** · lint · conformance suite của interface bị chạm | phút                       |
| **Merge queue**          | trước khi land             | cùng bộ suite trên **trunk-sẽ-là** — trường hợp giao thoa §2 gọi tên                      | vài phút đến vài chục phút |
| **Post-merge / nightly** | sau khi land, và theo nhịp | full suite toàn repository · tích hợp xuyên area · litmus automation · soak               | vài giờ — không chặn ai    |

| Check                                 | Nội dung                                                                                                                                    | Nguồn ràng buộc                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build và test theo area bị ảnh hưởng  | Dependency graph của monorepo quyết định chạy gì; không bao giờ chạy cả repository cho mỗi pull request                                     | Topology của monorepo (Platform NS §8). Runner cụ thể là lựa chọn tooling — một default không phải một coupling                                               |
| **Conformance suite của mọi gate ◆G** | Một pull request chạm interface đã đóng băng phải qua suite của interface đó; **rớt chặn merge một cách cấu trúc**, không phải theo quy ước | [Roadmap](../method/roadmap.md) §1b luật #7 — "gate không suite = gate giấy". CI là nơi một suite sống; suite có version, và đổi một suite là breaking change |
| Lint và static analysis theo area     | Lint rule của workspace, và sau này là static analysis riêng của Ecoma trên mọi process definition trong repository                         | Dogfooding tăng dần (§5)                                                                                                                                      |
| Supply-chain security                 | Dependency khoá cứng và audit; **CI là môi trường duy nhất tạo ra một artifact đã ký** — máy của developer không bao giờ ký một release     | Trust model của Hub: danh tính ký là của CI, không phải của một người                                                                                         |

## 4. Release & publish — thực thi trần, không thêm cơ chế

1. **Cut**: tag `vX.Y.Z` trên trunk, rồi đến nhánh release. Một tag phủ
   **mọi** artifact — server image, node binary, helm chart, SDK — để không
   artifact nào chạy lệch nhịp.
2. **Reproducible build**: mọi artifact truy về đúng một commit và một tag,
   kèm build provenance.
3. **Sign**: ký keyless gắn với danh tính CI — cùng trust chain mà publisher
   trên Hub dùng.
4. **Publish**: node binary và block first-party đi tới **Hub với vai trò
   publisher** ([RPA NS](../north-star/rpa.md) §4: node update qua Hub,
   không có kênh update riêng). Release pipeline của chính Ecoma vì thế là
   khách hàng đầu tiên của kênh phân phối mà nó bán. Server image và chart đi
   tới một OCI registry chuẩn, dưới cùng kỷ luật digest.
5. **Deprecation và end of life**: theo cửa sổ của trần và spec
   release-compatibility — charter này thực thi lịch đó, không lập pháp nó.

## 5. Dogfooding, theo hai pha

Một charter được phép nói về pha; trần thì không.

| Pha | CI/CD chạy trên                                                                                                                  | Chuyển pha                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Một CI vendor bên ngoài (một default, không phải một coupling: mỗi bước là một script mà runner nào cũng gọi được)               | —                                                                 |
| 2   | Vòng review và duyệt release chạy **như một process của Ecoma**: duyệt một release là một Gate, có migration entry và provenance | Khi đội đủ tự tin, sau milestone đầu tiên — không có ngày ép buộc |

## 5b. Phát triển có AI hỗ trợ — drift và revert

Đây chính là _bài toán mà Ecoma tồn tại để giải_
([Platform NS](../north-star/platform.md) §2 — AI nhân output lên đến khi
verification thành nút thắt), áp vào chính đội đang xây nó. Một AI viết code
là **một Filler của process phát triển**: cơ chế của chính trần, quay vào
workspace, không phải một cái mới bịa ra cho dịp này.

| Luật                                    | Nội dung                                                                                                                                                                                                                                                                                                                | Lý do                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Mọi pull request đi một đường**       | Người hay AI, đường đi như nhau; một pull request do AI tạo bắt đầu ở chế độ review toàn phần, rồi nới theo **loại thay đổi** khi lịch sử tích luỹ: tài liệu, test và refactor thuần có thể chuyển sang sampled, trong khi **cơ chế lõi, interface đã đóng băng và migration luôn giữ review toàn phần bất kể lịch sử** | Trust tier được dogfood vào chính process phát triển — tốc độ AI không bị phanh toàn bộ, chỉ phanh đúng chỗ có rủi ro |
| **AI không bao giờ tự merge ở pha 1**   | Mọi lần land đều qua một người và merge queue. Ở pha 2, calibration thật quyết định sampling                                                                                                                                                                                                                            | Không auto-pass trước khi calibration tồn tại                                                                         |
| **Drift có hai loại và hai liều thuốc** | _Semantic drift_ — code trôi khỏi trần: một thay đổi chạm một cơ chế **phải trích dẫn tài liệu và section của trần** mà nó thực thi, CI kiểm; thiếu là bị chặn. Cộng thêm một audit định kỳ spec-đối-code trên diff. _Quality drift_ — hồi quy: các tầng test cộng revert-first                                         | Thiếu một cái neo, một tác giả tối ưu cục bộ trôi khỏi trần từng bước nhỏ, mỗi bước có vẻ hợp lý và tổng thì sai      |
| **Provenance**                          | Một commit có AI hỗ trợ mang danh tính tool của nó trong một trailer; ở pha 2 nó là một sub-actor trong chính log                                                                                                                                                                                                       | Ai hay cái gì viết dòng nào là cùng một câu hỏi audit mà sản phẩm trả lời cho chính tenant của nó                     |

## 5c. ADR — nhà của quyết định implementation

- **Ba tầng quyết định, ba nhà**: cơ chế sản phẩm → **trần** (North Star /
  spec) · process của đội → **charter này** · lựa chọn implementation (ngôn
  ngữ, thư viện, data layout, framework) → **một ADR**, đánh số, append-only,
  supersede có lineage — kỷ luật version của trần soi xuống tận
  implementation. [ADR ledger](../method/adr-ledger.md) là nơi chứa chúng.
- Mỗi ADR mang context → option → **một verdict neo vào cơ chế** (một option
  thua vì là cơ chế yếu hơn hoặc vi phạm một nguyên tắc, không bao giờ vì
  công sức bỏ ra) → consequence. Một ADR **không được mâu thuẫn với trần**;
  nơi nó mâu thuẫn, trần thắng.
- **ADR khó đảo ngược được viết trước code** — lựa chọn runtime và ngôn ngữ,
  durable execution, storage layout — và mỗi cái sống sót qua ít nhất một
  vòng phản biện. ADR rẻ để đảo ngược được viết tại milestone cần đến nó.
  Không có big design up front ở tầng implementation: kiến trúc đích đã sống
  sẵn trong trần, và một ADR chỉ ghi lại nó được thực thi ra sao.

## 5d. Kiến trúc tham chiếu bên trong một package

Trần vốn đã là strategic DDD cộng hexagonal: bounded context là ba domain,
ubiquitous language là glossary, port và adapter là adapter taxonomy.
Pattern tactical bên trong một package được phép dưới bốn luật hoà giải; mọi
ADR kiến trúc tuân theo chúng, và khi xung đột thì trần thắng.

| #   | Luật                                                                                                                                                                                                                            | Lý do                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | **Event-sourced trước tiên**: aggregate rehydrate từ [Event Log](../spec/event-log.md); state là một projection; một CRUD repository làm nguồn ghi bị cấm                                                                       | Event là sự thật và state chỉ là dẫn xuất — một aggregate dựa trên state tạo ra một nguồn sự thật thứ hai  |
| 2   | **Vẽ lại vòng tròn Clean**: Event Log, content-addressed storage và lease, cùng các luật append-only và projection của chúng, nằm ở **domain ring** — chúng thuộc về trần và mang invariant. Chỉ backend cụ thể mới là chi tiết | "Database là một chi tiết", đọc một cách thô, đẩy log vào infrastructure; cách đọc đó gây chết người ở đây |
| 3   | **Naming theo glossary, nghiêm hơn cả DDD đòi hỏi**: không đồng âm khác nghĩa xuyên context — đổi tên thay vì chấp nhận một nghĩa mỗi context; identifier trong code dùng đúng tên trong glossary                               | Một từ mang hai nghĩa xuyên hai area của một monorepo là một lỗi giao thoa chờ nổ                          |
| 4   | **Area-first bên ngoài, layer bên trong**: root của repository tổ chức theo area (bounded context vật lý); layer Clean sống bên trong mỗi package và không bao giờ lật root thành layer-first                                   | Hình dạng root là convention đã chốt                                                                       |

Full tactical DDD là **lựa chọn per-package quyết định bằng ADR** — áp dụng
tăng dần, không bao giờ áp đặt toàn repository.

## 6. Review & ownership

- Review pull request là bắt buộc, với **owner gán theo area**. Một thư mục
  `packages/` mang owner riêng của nó, vì một lớp licence tách biệt không
  owner là một ranh giới không ai chịu trách nhiệm — mà lớp này lại cấp cho bên
  thứ ba những quyền không rút lại được. Tag `license:*` mới là thứ _thực thi_
  ranh giới đó, còn ownership chỉ quyết định ai review.
- Đổi một interface **đã đóng băng (◆G)** thì cần thêm owner của _mọi area
  đang tiêu thụ nó_ — cost-of-change-after-freeze của roadmap được diễn đạt
  thành một cơ chế review thay vì một lời nhắc.
- **Một contributor bên ngoài không bao giờ chạm được signing pipeline.**
  Gate contributor quyết định code có được nhận hay không; nó chưa bao giờ
  quyết định ai ký. Đây là hai câu hỏi tách biệt và cỗ máy giữ chúng tách
  biệt.
- **Legal review phủ licensing ở cấp file**, không chỉ điều khoản root: cây
  này mang nhiều lớp licence cùng lúc, và một review chỉ đọc root sẽ bỏ sót
  đúng ranh giới quan trọng.
- **Con đường của contributor được viết ở chỗ contributor đọc.** Một đóng
  góp từ bên ngoài là một pull request bình thường vào repository này, và
  mọi bước của nó sống trong `CONTRIBUTING.md` và `CLA.md`, được một gate
  thực thi. Một charter khai một gate mà không khai con đường tới nó sẽ là
  mô tả một cánh cửa không lối vào — và mô tả con đường đó trong một tài
  liệu mà contributor không mở ra sẽ lặp lại đúng lỗi đó, chỉ êm hơn.

## 7. Non-goals

- Không CI vendor hay tooling nào bị hardcode vào charter này — một default
  không phải một coupling.
- Không luật versioning hay compatibility mới: trần là canonical và charter
  này thực thi nó.
- Không feature flag lúc chạy nào tiến hoá thành một entitlement.
- Không nhánh domain sống dài, và **không tách repository theo domain sản
  phẩm** — workspace control-plane riêng tư là ngoại lệ duy nhất, lý lẽ nằm
  trong trần, và nó được thực thi thành hai workspace độc lập nối nhau bằng
  một pinned dependency. Repository này là gốc; không có tham chiếu nào máy
  theo được trỏ từ đây sang đó.

## 8. Litmus

1. Đổi CI vendor — release train, artifact contract, signing và
   publish-through-Hub có sống sót mà không đổi một cơ chế nào không?
2. Một release `vX.Y.Z` có truy về đúng một commit trunk, với **mọi**
   artifact mang tag đó không?
3. Một thay đổi phá conformance suite của một gate ◆G — merge có bị chặn
   **một cách cấu trúc**, không override nào ngoài một process truy vết được
   không?
4. Quét cả cây: có flag nào đọc lúc chạy để bật/tắt hành vi theo _danh tính
   người mua_ không?
5. Có đường nào để một máy cá nhân tạo ra một artifact đã ký release không?
6. Bất kỳ pull request nào — kể cả một cái mang migration — có revert được
   trong **một thao tác, dưới mười lăm phút, không cần hiểu nội dung của
   nó** không, vì đường down đã ship kèm nó?
7. Hai thay đổi đúng riêng lẻ nhưng sai khi gộp lại — chúng có bị chặn tại
   merge queue **trước khi** chạm trunk không?
8. Một thay đổi có AI hỗ trợ có đường nào lên trunk mà không qua review của
   người ở pha 1 không?
9. Clone repository này: có **tham chiếu nào máy theo được** tới workspace
   riêng tư không — một gitlink, một path, một entry config hay workflow?
   (Bắt buộc: không có.) Và một người ngoài có biết được **pull request của
   họ đi đâu** mà không mở bất kỳ tài liệu không công bố nào không? (Bắt
   buộc: có — một litmus mà chỉ maintainer trả lời được là đang đo sai
   người.)
