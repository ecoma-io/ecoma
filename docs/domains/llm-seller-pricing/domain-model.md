# LLM Seller Pricing — Domain Model

Bounded context `llm-seller-pricing`: seller-configured customer price, pricing schedule theo offer, per-request và per-token pricing, peak/off-peak theo IANA timezone, versioned schedule và pricing snapshot bất biến. Composed inside `llm-api`. Library `libs/llm-seller-pricing-domain`.

> Phạm vi: khái niệm pricing và ownership, các pricing dimension, token category (input/output/cached/reasoning), resolve tại admission, immutable snapshot, fixed-point arithmetic và invariant.
> Charge/seller payable/settlement → [`domains/llm-financial/`](../llm-financial/domain-model.md). Usage measurement → [`domains/llm-usage/`](../llm-usage/domain-model.md). Routing snapshot → [`domains/llm-consumer-routing/`](../llm-consumer-routing/domain-model.md). Offer/model identity → [`domains/llm-marketplace/`](../llm-marketplace/domain-model.md). Ranh giới chưa chốt → [`domains/open-boundaries.md`](../open-boundaries.md).

## 1. Phạm vi và ranh giới

Pricing **chỉ** sở hữu pricing schedule, version, price resolution và pricing snapshot; không reserve quota, không dispatch, không settle usage, không charge wallet, không giữ balance.

| Sở hữu                                                           | Không sở hữu                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pricing schedule · version · price resolution · pricing snapshot | Reserve/quota/settlement/usage (`llm-api` A7) · charge/ledger/escrow (`llm-financial`) · usage measurement/normalization (`llm-usage`) · logical request lifecycle / charged once (`llm-inference`) · routing candidate selection/fallback (`llm-consumer-routing`) · seller offer/model catalog/upstream endpoint (`llm-marketplace`) · tenant/membership/workspace (`llm-consumer-tenant`) |

- Seller-configured price **là** customer price. Provider cost là đại lượng độc lập, không được dùng để suy ra customer price; ownership/source của nó còn chưa chốt ([`docs/domains/open-boundaries.md`](../open-boundaries.md) OB-7).
- Pricing không giả định một markup, discount hay margin mặc định. Discount/fee trên customer charge là quyết định của `llm-financial`; nó áp dụng **trên** customer price, không làm thay đổi giá đã cấu hình.
- Per-request và per-token (input/output) là dimension **bắt buộc**; cached tokens là subset của input, reasoning tokens là subset của output — không double-count.
- Pricing là **versioned snapshot**: một logical request bind với một pricing snapshot tại admission; pricing change sau đó **không** alter giá đã admit.
- Tính tiền dùng **fixed-point** (số nguyên), **không** dùng floating point ở bất kỳ bước nào.
- Pricing snapshot persist cùng logical request record để audit/replay.

## 2. Ngôn ngữ dùng chung

| Thuật ngữ        | Ý nghĩa                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer price   | Số tiền customer trả cho usage đã phục vụ; đúng bằng mức giá seller cấu hình cho offer.                                                                             |
| Pricing schedule | Tập quy tắc giá áp dụng cho một offer trong một khoảng thời gian: per-request, per-token input/output, giá cached/reasoning, peak/off-peak, currency và đơn vị giá. |
| Pricing version  | Phiên bản bất biến của một pricing schedule, định danh bởi `(offer, version)` và có `effective_from` (UTC).                                                         |
| Peak/off-peak    | Hai bộ giá trong cùng schedule; bộ nào áp dụng được quyết định bằng admission timestamp quy về timezone của schedule.                                               |
| Pricing snapshot | Bản chụp bất biến của pricing version đã resolve + giá đã chọn + quyết định peak/off-peak + tham số làm tròn, bind tại admission.                                   |
| Provider cost    | Chi phí phải trả cho provider LLM. Đại lượng kinh tế độc lập, không dùng để suy ra customer price.                                                                  |

Customer price và provider cost là hai đại lượng **độc lập**; không có công thức nào biến đại lượng này thành đại lượng kia trong context này.

## 3. Pricing dimensions

Cả hai dimension đều **bắt buộc** trong mọi schedule:

- **Per-request** — giá cố định cho mỗi logical request, không phụ thuộc token.
- **Per-token** — giá theo token, gồm **input price** và **output price**; cả hai bắt buộc.

Token category theo semantics của `llm-usage` ([`domains/llm-usage/`](../llm-usage/domain-model.md)):

| Category           | Quan hệ với dimension          | Giá                                         |
| ------------------ | ------------------------------ | ------------------------------------------- |
| `input_tokens`     | chứa `cached_tokens`           | input price                                 |
| `cached_tokens`    | **subset** của `input_tokens`  | cached price, hoặc fallback input price     |
| `output_tokens`    | chứa `reasoning_tokens`        | output price                                |
| `reasoning_tokens` | **subset** của `output_tokens` | reasoning price, hoặc fallback output price |

- Cached price và reasoning price phải được cấu hình tường minh: hoặc có giá riêng, hoặc khai báo fallback về input/output price. Không có trạng thái "thiếu giá" — schedule thiếu cấu hình là schedule không hợp lệ.
- **Không double-count:** phần input được tính giá là `input_tokens − cached_tokens`; phần output được tính giá là `output_tokens − reasoning_tokens`. Cached/reasoning tokens chỉ được tính đúng một lần, bằng giá của chính chúng.
- Giá trị usage do `llm-usage` cung cấp; pricing không đo, không chuẩn hoá, không tổng hợp usage. Vi phạm invariant subset (`cached_tokens > input_tokens`, `reasoning_tokens > output_tokens`) là input không hợp lệ, không phải trường hợp được "sửa" về 0.

Công thức giá cho một logical request:

```
price = request_count × per_request_price
      + (input_tokens − cached_tokens) × input_price
      + cached_tokens × cached_price
      + (output_tokens − reasoning_tokens) × output_price
      + reasoning_tokens × reasoning_price
```

Toàn bộ phép nhân/cộng chạy trên số nguyên fixed-point.

## 4. Peak / off-peak

- Schedule có thể định nghĩa **peak window** cùng một bộ giá peak; ngoài window áp dụng bộ giá off-peak. Không có peak window ⇒ chỉ có một bộ giá.
- **Timezone** của window là dữ liệu schedule, dạng IANA timezone, do seller/console cấu hình; không giả định UTC.
- Window định nghĩa trên **local wall-clock time** của schedule: tập ngày bắt đầu, giờ bắt đầu và giờ kết thúc trong ngày. Window có `end < start` là window qua đêm và thuộc về ngày bắt đầu của nó.
- Tại admission, admission timestamp (UTC) được quy về local wall-clock của schedule; nếu rơi vào window thì chọn bộ giá peak, ngược lại chọn off-peak. Kết quả bind vào snapshot.
- **DST:** vì window nằm trên local wall-clock, cả hai lần xuất hiện của một giờ lặp lại (fall-back) đều khớp window như nhau; khoảng giờ bị bỏ qua (spring-forward) không tồn tại trên đồng hồ địa phương nên không admission timestamp nào khớp vào khoảng đó. Không có quy tắc riêng nào khác cho DST.
- Peak window/giá peak khác nhau theo schedule; không hard-code.

## 5. Pricing version

- Schedule là **versioned**: mỗi thay đổi tạo version mới với số version **monotonic** tăng dần trong cùng offer. Không downgrade, không bỏ số.
- `effective_from` (UTC) của version sau không được sớm hơn version trước.
- Version đã tạo là bất biến: không sửa tại chỗ, không xoá. Thay đổi giá là tạo version mới.
- Version và schedule là dữ liệu thuần; pricing không tự đọc đồng hồ — thời điểm do caller truyền vào.

## 6. Admission-time resolution và snapshot

- Tại admission, `llm-api` resolve theo `(offer, admission timestamp)`: chọn version có `effective_from <= admission timestamp` và số version lớn nhất của offer đó. Không có version phù hợp ⇒ từ chối, không đoán.
- Snapshot bất biến chứa:
  - `offer`, số version và `effective_from` của version đã dùng;
  - quyết định `peak` hoặc `off_peak`, kèm timezone của schedule khi có peak;
  - **giá đã resolve** cho từng dimension (per-request, input, cached, output, reasoning) sau khi áp fallback;
  - currency, scale của đơn vị giá, scale của số tiền, rounding rule;
  - admission timestamp.
- Snapshot **đủ để tái lập quyết định giá** mà không cần đọc schedule hiện hành: mọi giá trị cần cho phép tính đã nằm trong snapshot, không còn tham chiếu nào tới version đang sống.
- Snapshot bind vào logical request record cùng routing snapshot ([`domains/llm-inference/`](../llm-inference/domain-model.md) §3).
- **Pricing change sau admission không alter giá đã admit:** request đã admit giữ snapshot cũ cho mọi attempt, settlement, charge và adjustment.
- Snapshot persist cùng logical request record để audit/replay; reconciliation đọc snapshot, không đọc schedule hiện hành.

## 7. Fixed-point arithmetic và rounding

- **Không dùng floating point** ở bất kỳ bước tính tiền nào. Đơn vị giá và số tiền là số nguyên; token count và request count là số nguyên không âm.
- Schedule khai báo hai scale:
  - **price scale** — số chữ số thập phân của đơn vị giá đã cấu hình (đủ để biểu diễn giá per-token, ví dụ 6 nghĩa là `10^-6` đơn vị tiền tệ mỗi token);
  - **amount scale** — số chữ số thập phân của số tiền sau khi tính.
- Phép nhân/cộng chạy chính xác trên số nguyên ở price scale. **Chỉ một điểm làm tròn duy nhất**: chuyển tổng từ price scale sang amount scale, theo rounding rule của schedule.
- Rounding rule (`half_up`, `half_even`, `floor`, `ceil`) là dữ liệu schedule, được ghi vào snapshot. Không có giá trị mặc định ngầm.
- Không chuyển đổi giữa hai currency hoặc hai đơn vị khác nhau một cách ngầm. Pricing không thực hiện currency conversion; schedule và snapshot mang đúng một currency, và mọi phép tính trong một snapshot dùng chung currency/scale đó.
- Giá trị không hợp lệ (số âm, số không nguyên, scale ngoài miền cho phép, vượt giới hạn biểu diễn) bị từ chối; không có giá trị nào bị ép về 0.

## 8. Invariants

1. Seller-configured price **là** customer price; không suy ra customer price từ provider cost và không giả định markup.
2. Customer price và provider cost là hai đại lượng độc lập.
3. Mọi schedule có đủ per-request price, input price và output price; cached/reasoning price có giá riêng hoặc fallback tường minh.
4. Cached tokens là subset của input, reasoning tokens là subset của output; không token nào bị tính hai lần.
5. Mọi tính tiền dùng số nguyên fixed-point; không floating point.
6. Chỉ có một điểm làm tròn, theo rounding rule đã ghi trong snapshot.
7. Pricing snapshot bind tại admission và bất biến cho logical request.
8. Pricing change sau admission không alter giá đã admit.
9. Version monotonic trong cùng offer; version cũ bất biến, không downgrade/skip.
10. Peak/off-peak được quyết định tại admission theo IANA timezone của schedule và ghi vào snapshot.
11. Snapshot đủ để tái lập quyết định giá mà không cần schedule hiện hành.
12. Không schedule nào bị coi là hợp lệ khi thiếu giá; không giá trị thiếu nào được hiểu là 0.
13. Pricing chỉ sở hữu schedule, version, price resolution và snapshot; không reserve quota, không dispatch, không settle usage, không charge wallet, không giữ balance.

## 9. Ranh giới chưa chốt

Hai quyết định dưới đây **chưa** được chốt bởi tài liệu hiện có. Pricing không tự quyết chúng; implementation chỉ phụ thuộc phần đã chốt.

- **Provider cost — ownership và source** ([`docs/domains/open-boundaries.md`](../open-boundaries.md) OB-7): tài liệu hiện tại không nói ai sở hữu provider cost, lấy từ đâu (bảng giá provider, invoice, hợp đồng), tính theo cách nào, hay định danh bằng currency nào. Vì vậy pricing coi provider cost là đại lượng ngoài phạm vi và **không** là input của price resolution.
- **Pricing granularity — offer hay normalized model** ([`docs/domains/open-boundaries.md`](../open-boundaries.md) OB-8): pricing schedule gắn với **offer** (đơn vị seller phục vụ customer, nhất quán với `llm-marketplace`). `llm-financial/adr/0006` dùng cụm "base model price"; tài liệu chưa chốt schedule có được dùng chung cho nhiều offer của cùng normalized model hay không. Implementation giữ key theo offer; không mở rộng sang normalized model khi chưa có quyết định.

## 10. Cross-reference

- Charge/seller payable/settlement → [`domains/llm-financial/`](../llm-financial/domain-model.md) §3.
- Usage measurement, token category và subset invariant → [`domains/llm-usage/`](../llm-usage/domain-model.md).
- Routing snapshot và strategy "lowest customer price" → [`domains/llm-consumer-routing/`](../llm-consumer-routing/domain-model.md).
- Logical request lifecycle / charged once → [`domains/llm-inference/`](../llm-inference/domain-model.md).
- Offer, normalized model identity → [`domains/llm-marketplace/`](../llm-marketplace/domain-model.md).
- Quota/settlement authority → [`architecture/01-architecture.md`](../../architecture/01-architecture.md) A7, invariant 16.
