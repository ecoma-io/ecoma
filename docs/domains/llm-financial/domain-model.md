# Bounded context `llm-financial` — Domain Model

`llm-financial` là bounded context phụ trách **tính đúng đắn tiền tệ của đường LLM**: billing account, wallet, credit/deposit, sponsor funding, available balance, double-entry ledger, reservation, budget escrow, budget lease, customer charge, seller payable, settlement, refund/adjustment, reconciliation và financial audit.

> Phạm vi: monetary correctness của LLM product. Không thay thế `payment` (payment transaction và payout execution canonical). `llm-financial` sở hữu monetary state; `llm-inference` sở hữu logical request lifecycle; `llm-usage` sở hữu usage measurement. Quan hệ với `payment` vẫn là open boundary ([`open-boundaries.md`](../open-boundaries.md) OB-1). Tài liệu này mô tả business knowledge, không phải technical architecture.

## 1. Phân biệt các khái niệm (bắt buộc)

| Khái niệm                         | Ý nghĩa                                                                                                           | Khác biệt cốt lõi                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Budget lease**                  | Quyền tiêu liên tục trong một cửa sổ thời gian cho một consumer/key, cấp bởi financial admission local            | Khác **quota lease** (giới hạn tài nguyên token/request của `llm`, A7); lease tài chính không cấp quota                                                           |
| **Quota lease**                   | Giới hạn tài nguyên do `llm-api` cấp (A7)                                                                         | Authority PostgreSQL `db-llm-gateway`; không phải tiền                                                                                                            |
| **Reservation (quota)**           | Bản ghi bền giữ **quota** tại thời điểm reserve, idempotent theo quota `reservation_id` (A7)                      | Giữ **tài nguyên**, không giữ **tiền**; sở hữu quota authority (`llm-api`), không phải khái niệm tài chính của context này — financial chỉ phân biệt định danh    |
| **Reservation (financial)**       | Bản ghi bền giữ **tiền** trong wallet (`available → held`), idempotent theo financial `reservation_id` riêng (§5) | Khác quota reservation: hai authority, hai định danh độc lập, correlation qua `request_id`/`attempt_id`; không đồng nhất hai ID (ADR-0028 §5)                     |
| **Actual charge**                 | Khoản tiền thực sự thu từ customer sau settlement                                                                 | Khác reservation (chỉ giữ chỗ) và khác escrow (chỉ giữ tiền chờ)                                                                                                  |
| **Escrow**                        | Tiền giữ chờ sử dụng, chưa tiêu; có thể release khi không dùng                                                    | Khác **outstanding liability** (nghĩa vụ chưa thanh toán với seller/provider)                                                                                     |
| **Outstanding liability**         | Nghĩa vụ phải trả (seller payable, provider cost) chưa settle                                                     | Không phải tiền giữ; provider cost là đại lượng độc lập, ownership/source chưa chốt ([`open-boundaries.md`](../open-boundaries.md) OB-7)                          |
| **Provider cost**                 | Chi phí thực tế phải trả cho provider LLM                                                                         | Khác **customer charge** (giá bán); ownership/source còn chưa chốt ([`open-boundaries.md`](../open-boundaries.md) OB-7)                                           |
| **Customer charge**               | Số tiền thu từ customer cho usage đã phục vụ                                                                      | Tính từ customer price (seller-configured, `llm-seller-pricing`) trừ discount/fee; khác provider cost                                                             |
| **Seller payable**                | Số tiền phải trả cho seller (offer/catalog)                                                                       | Khác **actual seller payout** (tiền đã thực trả)                                                                                                                  |
| **Actual seller payout**          | Tiền đã thực sự chi trả cho seller                                                                                | Sau settlement/payout, không phải lúc phát sinh payable                                                                                                           |
| **Payment transaction**           | Giao dịch thanh toán do `payment` sở hữu                                                                          | Khác **LLM credit** (đơn vị giá trị trong ledger của `payment`/financial)                                                                                         |
| **LLM credit**                    | Đơn vị giá trị lưu trong ledger                                                                                   | Không đồng nhất với quota usage                                                                                                                                   |
| **Sponsor**                       | Bản nhận **trách nhiệm tài chính nội bộ**: ủy quyền và chịu trần cấp funding cho billing account (ADR-0028)       | Không phải Superadmin, owner `sub`, Seller tenant hay legal principal; có thể cùng chỉ tới tổ chức thật nhưng là tham chiếu domain riêng                          |
| **Sponsor funding authorization** | Ủy quyền durable cho sponsor cấp tiền vào một billing account, kèm trần per-account và `evidence_ref`             | Không phải bút toán; là điều kiện tiên quyết của mọi sponsor grant                                                                                                |
| **Sponsor grant**                 | Bút toán kép cấp UC từ nguồn tài trợ nội bộ vào billing account                                                   | Đối ứng `sponsor_funding_clearing`; khác **deposit** (nguồn `payment`, đối ứng `funding_clearing`)                                                                |
| **Subsidy**                       | Chênh lệch kinh tế giữa allocated provider cost và giá thu consumer khi giá nội bộ thấp hơn cost                  | Không phải bút toán của `llm-financial` (OB-7 mở); không được che giấu — chỉ quan sát được qua chuỗi tham chiếu usage → offer → snapshot → charge (ADR-0028 §7.3) |

## 2. Billing account & wallet

### Billing account

Danh tính tài chính của một consumer (workspace/customer). Mang **hai tham chiếu opaque** (không FK xuyên DB): `tenant_ref` — beneficiary/workspace Consumer tenant, khoá attribution kế toán; và `owner_ref` — tham chiếu `sub` cho provenance/actor (A21), **không** phải khoá sở hữu tài chính. Seller tenant là **tham chiếu riêng** do `llm-seller-tenant` sở hữu — billing account không thay thế Seller identity. MVP ([ADR-0028](./adr/0028-internal-sponsorship-funding-first-party-financial-model.md) §3.2): mỗi Consumer tenant có đúng **một** billing account, tạo qua bề mặt provisioning của `llm-financial`; topology nhiều-account hay chung-account là quyết định tương lai tường minh.

### Wallet

Chứa available balance và holds (escrow). Wallet luôn denomination VND theo ADR-0004; không mô hình hóa ví đa tiền tệ. Một billing account có thể có nhiều wallet theo **loại instrument** (UC wallet / EC wallet), không theo currency tùy ý.

### Available balance

Số dư có thể sử dụng ngay, sau khi trừ holds và reserved.

### Conversion EC → UC

- Chỉ EC **available** được convert; EC đang `held` bị từ chối (`conversion_source_unavailable`).
- `ratio` do caller cấp, phải dương và cho kết quả nguyên chính xác; không mặc định 1:1, không áp fee (ADR-0005, ADR-0006 — vẫn OPEN).
- Authorization là opaque evidence do tầng authorization sở hữu: `same_identity`, `seller_payout_authorized`, `console_payment_authorized` đều `true` và khớp actor/source seller tenant/destination console tenant; thiếu hoặc lệch thì fail closed.
- Hai transaction cân bằng riêng: EC side `available → conversion_clearing`, UC side `conversion_clearing → available`. Idempotent theo `conversion_id`; record conversion bất biến, không có operation chuyển ngược.

### Balance state ownership (per ADR-0004)

| State                | Thuộc                     | Ý nghĩa                                             |
| -------------------- | ------------------------- | --------------------------------------------------- |
| `available`          | Wallet available balance  | Có thể dùng ngay sau khi trừ holds/reserved.        |
| `held` / `reserved`  | Wallet held balance       | Tiền giữ cho request/lease/payout reservation.      |
| `accrued`            | Seller payable projection | Earnings đã phát sinh, chưa settle.                 |
| `settled`            | Seller payable projection | Earnings đã settle theo kỳ.                         |
| `available earnings` | Seller payable projection | Earnings đã available sau ngày 20 (per ADR-0007).   |
| `converted EC`       | Conversion record         | EC đã convert sang UC (irreversible).               |
| `paid`               | Payout execution record   | EC đã được payout thành công (có evidence).         |
| `tax withheld`       | Tax withholding liability | Khoản giữ lại theo chính sách thuế (rate OPEN).     |
| `payout reservation` | Payout reservation record | EC giữ cho một payout request chưa capture/release. |

Không state nào là source of truth ngoài owner đã chỉ rõ; projection/cache không thay thế ledger.

## 3. Credit / deposit / sponsor funding

**Credit** tăng available balance (top-up, refund credit, adjustment credit). **Deposit** là tiền nhận vào từ payment: state `pending` → `credited` → (có thể) `reversed`, và pending **không phải** tiền trong ví cho tới khi payment settle. `reversed` là transaction đối ứng, không phải xoá: `total` giảm đúng bằng số đã credit và conservation (§14) vẫn giữ. Luồng tiền (theo ledger account ở §4):

| Operation         | Tiền tệ                        | Ghi chú                                                                                                                               |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `registerDeposit` | không post                     | Tạo deposit `pending`; pending **không phải** tiền trong ví                                                                           |
| `creditDeposit`   | `funding_clearing → available` | Operation tạo **giá trị mới** vào wallet (cùng `creditGrant`); conversion EC→UC chỉ chuyển giá trị đã có giữa hai denomination domain |
| `reverseDeposit`  | `available → funding_clearing` | Compensating entry; từ chối nếu available không đủ để đảo                                                                             |

### Sponsor funding ([ADR-0028](./adr/0028-internal-sponsorship-funding-first-party-financial-model.md))

Cấp UC từ **nguồn tài trợ nội bộ** — operation riêng, không tái dùng deposit: deposit ngữ nghĩa gắn với fiat payment đã confirm (ADR-0003, ADR-0009) và đối ứng `funding_clearing`; sponsor grant đối ứng `sponsor_funding_clearing` với nguồn kinh tế là authorization của sponsor (`evidence_ref` trỏ ra quyết định ngân sách authoritative ngoài sản phẩm). Lifecycle đối xứng deposit:

| Operation                                                    | Bút toán                               | Ghi chú                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerGrant`                                              | không post                             | Tạo grant `pending` với provenance bất biến (`grant_id`, `authorization_ref`, `amount`, `actor_ref`); pending không phải tiền trong ví                                                                                                                                                        |
| `creditGrant`                                                | `sponsor_funding_clearing → available` | Cấp UC; kiểm authorization `active`, sponsor `active` + trần trong **cùng persistence transaction**; lỗi: `funding_authorization_required`, `sponsor_ceiling_exceeded`, `authorization_ceiling_exceeded`                                                                                      |
| `reverseGrant`                                               | `available → sponsor_funding_clearing` | Compensating entry (clawback) **full-only**: đảo đúng toàn bộ `amount` gốc, một lần (`credited → reversed` terminal); chỉ từ `available` — `held`/`charged` không bị đụng; `available` không đủ ⇒ `insufficient_available_balance`, grant giữ `credited`; không phải "hoàn tiền cho consumer" |
| `updateSponsorCeiling` / `updateFundingAuthorizationCeiling` | không post                             | Đổi trần cấu hình administrator-managed — operation có kiểm duy nhất, audit tương ứng (`sponsor_ceiling_updated` / `sponsor_funding_authorization_ceiling_updated`); không qua bootstrap (ADR-0028 §5)                                                                                        |

- Idempotency suy ra tất định: transaction `sponsor_grant:<grant_id>:credit` / `sponsor_grant:<grant_id>:reverse`; idempotency key `idem:sponsor_grant:<grant_id>:credit` / `idem:sponsor_grant:<grant_id>:reverse` (pattern §4). Replay reversal cùng payload trả kết quả gốc (kể cả trên grant đã `reversed` — không double-reverse); khác payload ⇒ `idempotency_conflict`. Sponsor `suspended` hay authorization không `active` ⇒ `funding_authorization_required` — cùng nhóm "không có funding authorization hiệu lực", không thêm mã mới (ADR-0028 §5).
- **Reversal không có partial**: UC là fungible — ledger không gắn từng UC với grant nguồn, partial clawback không xác định được phần còn lại và phá công thức trần net; reversal thành công phục hồi headroom cả hai trần (net credited giảm). Clawback một phần là quyết định tương lai nếu phát sinh (ADR-0028 §4).
- Trần: **sponsor ceiling** (tổng net credited của sponsor) và **authorization ceiling per billing account** — bounds liability của nguồn tài trợ, không phải second ledger; usage bị chặn bởi `available` như mọi wallet (ADR-0028 §5).
- MVP không có expiry: UC được cấp giữ nguyên `available` cho tới khi tiêu hoặc bị reverse. Không có generic funding operation ngoài ba funding operation trên — `updateSponsorCeiling`/`updateFundingAuthorizationCeiling` không phải funding operation (không post, chỉ cấu hình trần).

## 4. Double-entry ledger

Mọi thay đổi balance phải là bút toán kép: debit = credit trong cùng transaction; tổng debit = tổng credit, và balance không âm (trừ khi overdraft được cấp phép rõ ràng). Ledger entry mang `entry_id`, `transaction_id`, `account`, `wallet_id`, `billing_account_id`, `denomination`, `amount`, `debit/credit`, `reference`, `created_at`, `fencing_token`. Đơn vị ledger luôn `VND` (ADR-0004), nhưng `UC` và `EC` là hai **denomination domain** độc lập: một transaction thuộc đúng một denomination, nên không có phép cân nào trộn hai miền giá trị.

### Ledger account (vocabulary đóng)

Mỗi account chỉ có một nghĩa; không có account nào đại diện chi phí provider (§17).

| Account                    | Dùng cho                                    |
| -------------------------- | ------------------------------------------- |
| `wallet_available`         | Balance khả dụng                            |
| `wallet_held`              | Tiền đang giữ (reservation, escrow)         |
| `wallet_charged`           | Tiền đã thu (customer charge)               |
| `funding_clearing`         | Đối ứng deposit / reversal                  |
| `sponsor_funding_clearing` | Đối ứng sponsor grant / reversal (ADR-0028) |
| `earnings_clearing`        | Đối ứng credit earnings của seller          |
| `conversion_clearing`      | Đối ứng leg conversion EC→UC                |

### Reference type (vocabulary đóng)

`reference` mô tả nguồn bút toán, không phải một field tự do: `credit`, `credit_reversal`, `reservation`, `reservation_capture`, `reservation_release`, `settlement`, `refund`, `charge_adjustment`, `conversion`, `escrow`, `escrow_release`, `earning`, `sponsor_grant`, `sponsor_grant_reversal` (ADR-0028).

### Điểm duy nhất đổi balance

`commitTransaction` là **điểm duy nhất** làm thay đổi balance. Operation kiểm nghiệp vụ trước (đủ tiền, đúng state), rồi commit post transaction và **suy lại** ba balance từ ledger (`deriveWalletBalances`). Balance là projection của ledger, không phải state song song — đó là cơ chế giữ invariant 5, không chỉ là lời hứa.

### Idempotency, fencing và tính tất định

- Idempotency tính trên **fingerprint** của transaction: wallet, account, denomination, reference, và danh sách leg theo đúng thứ tự khai báo. Replay cùng fingerprint trả transaction gốc; cùng key khác fingerprint là `idempotency_conflict` và ledger **không** đổi. Thứ tự leg là một phần của payload, không được chuẩn hoá ngầm.
- Wallet mang `fencing_token` hiện hành. `commitTransaction` từ chối token khác (`stale_fencing_token`), và mọi entry được đóng dấu token của operation sinh ra nó. Nhờ đó operation của epoch cũ bị loại theo fencing, không theo thứ tự thời gian.
- Cùng một book cộng cùng một input cho cùng một output: ledger transaction id, entry id và idempotency key được **suy ra tất định** từ id của entity sinh ra chúng, không random và không đọc đồng hồ. Mọi mốc thời gian và định danh do caller cấp, nên replay dựng lại đúng bút toán cũ thay vì sinh bút toán thứ hai cùng nghĩa.

## 5. Reservation (financial)

Giữ tiền trong wallet cho một request/lease sắp tới. Idempotent theo **financial `reservation_id`** — định danh riêng, khác quota `reservation_id` của A7, **suy tất định từ financial admission identity** `(request_id, attempt_id)` (không random — ADR-0028 §5); correlation giữa hai loại đi qua `request_id`, không có ID generic dùng chung. Admission giữ **amount ước tính tối đa** của attempt (usage bound × applicable price) — input bắt buộc; mọi capture/release chạy trong phạm vi amount đó. Fallback đổi offer: mỗi attempt được phục vụ mang financial admission identity riêng tất định từ `(request_id, attempt_id)` — commit mà response mất ⇒ replay cùng identity trả kết quả gốc, không double-reserve; payload khác ⇒ `idempotency_conflict`. Release/capture chỉ sau khi có bằng chứng provider đã thực thi hoặc đã không thực thi (fencing + reconciliation); lease expiry **không** chứng minh gateway cũ đã dừng tiêu nên không phải căn cứ để release.

| Operation | Tiền tệ                                               | Ghi chú                                                                                                                                                                                                                                                                              |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reserve` | `available → held`                                    | Idempotent theo `reservationId`; từ chối vượt available                                                                                                                                                                                                                              |
| `capture` | `held → charged` (+ `held → available` cho phần thừa) | Capture một phần bắt buộc `releaseRemainder: true`, nếu không `remainder_release_required`; capture không vượt amount admission đã giữ — usage vượt estimate ⇒ charge capped tại amount đã giữ + audit `financial_charge_capped` + alert/reconciliation, không nợ ngầm (ADR-0028 §5) |
| `release` | `held → available`                                    | Chỉ khi caller có bằng chứng provider chưa thực thi; lib **không** tự release vì timeout; reservation không tồn tại ⇒ no-op idempotent                                                                                                                                               |
| `settle`  | gọi `capture` với `releaseRemainder: true`            | Tạo charge `posted`; settlement **không** post thêm bút toán balance (sẽ cộng đúp); accrual payable tuỳ chọn, bounded bởi fact association (invariant 15 — ADR-0028 §7.1)                                                                                                            |

Settlement dùng capture làm mutation tiền tệ duy nhất; ghi nhận doanh thu là projection kế toán ngoài wallet. Settlement idempotent theo `settlement_id` (suy tất định từ financial admission identity — ADR-0028 §5); settlement thứ hai trên cùng reservation bị `capture` từ chối (`reservation_already_finalized`), nên không có duplicate charge. Replay cùng `settlement_id` với payload khác (kể cả seller share) là `idempotency_conflict`, không phải replay. Usage thật không thu được (`usage_status = missing`): settle capture theo **amount đã giữ** (không phần thừa) + audit `financial_settle_missing_usage`, alert + reconciliation; correction hạ charge khi usage thật xác định (§10 `adjustCharge`) — nếu usage thật không bao giờ xác định, chênh lệch được xử lý qua reconciliation/alert, resolution mặc định là quyết định tương lai (ADR-0028 §13).

## 6. Budget escrow & budget lease

- **Budget escrow**: tổng số tiền được earmark cho một consumer trong một khoảng thời gian; là nguồn để cấp budget lease.
- **Budget lease**: cấp cho consumer/key một ngân sách liên tục (amount per window) để tiêu mà không cần gọi coordinator mỗi request. Lease có `epoch`/`fencing_token`. Admission: financial admission dùng bounded escrow/leases và local atomic admission; **không** gọi DB/coordinator per inference request.
- Lease expiry **không** chứng minh gateway cũ đã dừng tiêu: gateway cũ có thể vẫn tiêu với epoch cũ. Cần fencing token/epoch để từ chối lease cũ, và reconciliation trước khi reallocate escrow.
- **Local admission là decisioning, không phải kế toán** (ADR-0028 §5): admission lease-local không tạo bản ghi kế toán per request và không thay thế settlement. Kế toán durable của usage đã phục vụ xảy ra tại settlement — capture ghi bền với khoá tất định từ `(lease, request_id, attempt_id)`, một lần per identity; khoá tái dựng được sau crash vì attempt record (mang `request_id`, `attempt_id`, **amount financial admission đã giữ**, `lease_ref` khi admission qua lease) được Application ghi bền trước dispatch (`llm-api` §13) — amount nằm trong attempt record nên cap `charge ≤ amount` kiểm được sau crash trên cả hai đường admission.
- **Crash/replay của gateway**: settlement debt (usage đã phục vụ chưa ghi bền) là correctness requirement — kế toán chỉ trễ, không mất. Lease của instance chết bị từ chối theo epoch/fencing (`observedEpoch > lease.epoch`); unused allocation chỉ quay lại `available` qua `revokeLease` + `closeEscrow` sau reconciliation, không auto-return theo đồng hồ.
- **Duplicate capture/release bị chặn bởi khoá tất định + fingerprint** (§4): replay cùng identity trả kết quả gốc, cùng key khác fingerprint là `idempotency_conflict`.
- **Uncertain provider outcome** (`may_have_executed`): không release, không retry mù — escalation; settle theo usage thật khi evidence chốt. Exposure của toàn bộ cửa sổ bị bound bởi lease amount × window — bounded risk đã ghi rõ ở §15/§16.

| Operation     | Tiền tệ            | Ghi chú                                                                                                                               |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `openEscrow`  | `available → held` | Tiền rời available ngay; idempotent theo `escrow_id`                                                                                  |
| `issueLease`  | không đổi balance  | Phân bổ trong phần held nên không thể vượt escrow; `allocated + amount <= escrow.amount`; epoch đơn điệu tăng; `expiresAt > issuedAt` |
| `revokeLease` | không đổi balance  | Cần `observedEpoch > lease.epoch`, nếu không `lease_not_stale`                                                                        |
| `closeEscrow` | `held → available` | Cần `reconciliationRef` (`reconciliation_required`) **và** không còn lease `active`/`exhausted`                                       |

## 7. Customer charge

- Phát sinh sau settlement của usage: `charge = f(usage, price, discount)` — capped tại amount financial admission đã giữ (ADR-0028 §5); idempotent theo định danh settlement tài chính; khác provider cost (chi phí thực) và khác seller payable.
- `refundableAmount = amount + increase - decrease - refunded`; refund không bao giờ vượt phần còn hoàn được (`refund_exceeds_charge`).

## 8. Seller payable & payout

- **Seller payable**: nghĩa vụ phải trả cho seller khi usage thuộc offer/catalog của seller. Là **projection EC**, không mang beneficiary/fiat amount, không phải payout và không phải provider cost. Chỉ accrue cho seller **không** liên kết `FirstPartyLegalPrincipal` Ecoma-io — bất kể trạng thái principal (invariant 15, ADR-0028 §7.1).
- **Actual seller payout**: tiền thực chi trả, sau settlement/payout flow (có thể qua `payment`).
- Không đồng nhất payable với payout; payout có thể bị delay/adjustment.

Mỗi transition thêm một record cùng `payable_id` với `version + 1`; record cũ giữ nguyên, `currentPayable` trả version cao nhất.

- `accruePayable` (version 1, `accrued`).
- `settlePayable` (`accrued → settled`): cần `settledAt >= available_at`; hold đang hiệu lực cho seller tenant/kỳ chặn transition (`payable_on_hold`).
- `markPayablePaid` (`settled → paid`, terminal): **bắt buộc** `payoutEvidenceRef` (`payout_evidence_required`). Request timeout hay sự tồn tại của payout request không chứng minh tiền đã chi. `paid` chỉ nhận replay cùng evidence; evidence khác là `idempotency_conflict`.
- `adjustPayable` (`accrued` hoặc `settled` → `adjusted`): version mới mang amount đã sửa, kèm lý do.

### Hold chặn settlement

`openHold` / `releaseHold` / `activeHolds` không đổi balance — hold chỉ là điều kiện được kiểm trong `settlePayable`. Một hold cần lý do và actor; `settlement` hold cần `period`, còn `account` hold cấm `period`. Hold không phải restriction: nó không xoá earnings, không chặn seller đăng nhập hay publish.

## 9. Settlement

- Chốt usage đã phục vụ vào ledger: capture phần được tính, release phần thừa, tạo charge `posted`, accrual payable tuỳ chọn.
- Settlement debt (usage đã phục vụ nhưng chưa ghi bền) là correctness requirement — kế toán chỉ trễ, **không mất** (ADR-0028 §5); cơ chế recovery khi PG down còn mở ([`open-boundaries.md`](../open-boundaries.md) OB-3).

## 10. Refund / adjustment

Refund trả tiền cho customer bằng ledger entry ngược; adjustment sửa sai (overcharge/undercharge) bằng entry mới, không sửa entry cũ (append-only ledger). Cả hai idempotent theo `refund_id`/`adjustment_id`.

| Operation      | Tiền tệ                                                              | Ghi chú                                                 |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| `refundCharge` | `charged → available`                                                | Tối đa `refundableAmount`; không sửa `amount` gốc       |
| `adjustCharge` | `increase`: `available → charged`; `decrease`: `charged → available` | Bắt buộc `reasonRef` để audit; charge chuyển `adjusted` |

`reasonRef` là một phần payload idempotency: cùng id nhưng khác lý do là `idempotency_conflict`, không phải replay.

## 11. Reconciliation

- Đối soát giữa `llm-financial` ledger, `payment` ledger (qua contract/event/API/snapshot — không truy cập DB trực tiếp, invariant 7), `llm-usage` usage, `llm-api` reservation, provider invoice.
- Phát hiện mismatch: missing charge, duplicate charge, escrow leak, payable mismatch.
- Kết quả đối soát phân biệt ba trạng thái: `matched`, `mismatched`, `unverifiable` (thiếu nguồn quan sát). Thiếu dữ liệu **không** được báo là khớp.
- Chạy định kỳ + on-demand; mismatch tạo alert + audit.

`reconcileWallet` là **hàm thuần so sánh**, không mutation: expected = `deriveWalletBalances` từ ledger; observed do caller cấp. `discrepancies` liệt kê từng field lệch. `findConservationViolation` kiểm cấu trúc nội tại của một snapshot, không so hai nguồn.

## 12. Financial audit

Append-only log của mọi thay đổi tài chính: actor, action, target, amount, reference, correlation ID, timestamp, fencing token. Không chứa secret/token. Vocabulary hành động là đóng; audit **không** có idempotency key vì audit là log, không phải mutation: hai lần ghi cùng action và correlation ID là hai sự kiện, gộp chúng sẽ che mất một lần gọi thật. Vocabulary mở rộng cho sponsor và admission settlement: `sponsor_registered`, `sponsor_funding_authorized`, `sponsor_funding_authorization_revoked`, `sponsor_grant_registered`, `sponsor_grant_credited`, `sponsor_grant_reversed`, `sponsor_ceiling_updated`, `sponsor_funding_authorization_ceiling_updated`, `financial_charge_capped` (capture bị cap tại amount admission đã giữ), `financial_settle_missing_usage` (settle capture toàn amount khi usage missing) (ADR-0028 §4).

## 13. State machines

- **Deposit**: `pending → credited → reversed` (payment fail/refund). `reversed` là transaction đối ứng, không phải xoá.
- **Reservation**: `reserved → captured | released`; `expired` thuộc vocabulary nhưng **không** suy ra từ đồng hồ — hết thời gian không chứng minh provider đã dừng, nên caller quyết định sau fencing/reconciliation (invariant 6).
- **Budget lease**: `active → revoked | expired | exhausted`; chuyển trạng thái do caller cấp evidence, không do đồng hồ trong domain.
- **Budget escrow**: suy ra từ `released_at` (`open | released`) — không lưu state riêng.
- **Seller payable**: `accrued → settled → paid` (chỉ khi có payout evidence, terminal) | `adjusted` từ `accrued` hoặc `settled`.
- **Customer charge**: `pending` (giá trị khởi tạo) `→ posted → refunded | adjusted`. `settle` tạo thẳng `posted`; charge `pending` bị từ chối refund/adjust.
- **Sponsor grant**: `pending → credited → reversed` — đối xứng deposit; `reversed` là compensating entry, không phải xoá (ADR-0028 §4).

## 14. Invariants

1. **Double-entry**: mọi ledger transaction có debit = credit.
2. **Non-negative balance** (trừ overdraft được cấp phép rõ ràng).
3. **Reservation idempotency**: cùng financial `reservation_id` không tạo duplicate hold.
4. **Settlement idempotency**: cùng định danh settlement tài chính không tạo duplicate charge (§5).
5. **Escrow conservation**: `available + held + charged = total` cho mỗi wallet (total = tổng tiền đã nạp vào wallet; release trả vào available, capture chuyển held → charged). Deposit `reversed` phải tạo compensating entry để giữ bất biến; không được silently giảm `total` khi `held`/`charged` đã tham chiếu deposit đó. Balance luôn được suy lại từ ledger, nên bất biến là một định nghĩa chứ không phải một assertion rời.
6. **No reallocation without reconciliation**: budget lease expiry không tự động giải phóng escrow nếu provider có thể đã thực thi; phải fencing + reconcile.
7. **Append-only ledger**: không sửa/xoá entry đã commit; correction bằng entry mới.
8. **Provider cost ≠ customer charge**: không đồng nhất hai đại lượng.
9. **Seller payable ≠ payout**: không đồng nhất.
10. **Reservation (quota) ≠ charge (money)**: không đồng nhất.
11. **Budget lease ≠ quota lease**: không đồng nhất.
12. **Unused escrow ≠ outstanding liability**: không đồng nhất.
13. **Sponsor ceiling**: tổng net credited của một sponsor không vượt ceiling của nó; kiểm trong cùng persistence transaction với bút toán — không có cửa sổ check-then-act (ADR-0028 §5).
14. **Funding authorization required**: mọi sponsor grant trỏ đúng một authorization còn `active`; không có grant vô nguồn (ADR-0028 §3.2).
15. **Payable entitlement**: payable chỉ accrue cho seller có nghĩa vụ settle thật — seller **không** liên kết tới `FirstPartyLegalPrincipal` Ecoma-io (bất kể trạng thái principal — trạng thái chỉ điều khiển serving eligibility, ADR-0027 §5); classification boolean một mình không bao giờ là tiêu chí (ADR-0028 §7.1).
16. **Financial admission là điều kiện dispatch**: mọi attempt được phục vụ phải qua financial admission theo giá của **chính offer phục vụ attempt đó** — lease-local khi budget lease còn cover, durable reserve khi không; offer thay thế trong fallback không kế thừa giá offer gốc; thiếu coverage ⇒ fail closed, không dispatch (ADR-0028 §7.4).
17. **Hai định danh reservation độc lập**: quota reservation (A7) và financial reservation là hai bản ghi của hai authority, hai ID riêng, correlation qua `request_id`/`attempt_id`; không có `reservation_id` generic dùng chung (ADR-0028 §5).
18. **Reversal full-only, chỉ từ `available`**: `reverseGrant` đảo đúng amount gốc, một lần, `credited → reversed` terminal; `held`/`charged` không bao giờ bị reverse; `available` không đủ ⇒ `insufficient_available_balance`, grant giữ `credited` (ADR-0028 §4).

## 15. Failure behavior

- **Lease/request timeout**: không release reservation chỉ vì timeout nếu provider có thể đã thực thi. Lease expiry không chứng minh gateway cũ dừng tiêu; cần fencing epoch/token và reconciliation trước reallocation.
- **Partition**: không thể đồng thời đảm bảo (a) an toàn tài chính toàn cục nghiêm ngặt, (b) không false reject khi balance toàn cục còn, và (c) availability độc lập với coordinator dưới mọi partition. Phải chọn trade-off rõ ràng; không tuyên bố giải cả ba. Financial admission dùng bounded escrow/leases + local atomic admission để tránh DB/coordinator call per request, chấp nhận bounded risk trong cửa sổ lease.
- **PG down**: fail closed cho request mới; stream đang chạy hoàn tất → settlement debt. Không circuit-breaker để phục vụ khi settlement không bền.
- **Mismatch reconciliation**: alert + audit, không tự sửa số liệu mà không ghi adjustment entry.

## 16. Distributed systems trade-off (ghi rõ)

Hệ thống chọn: **bounded financial safety + coordinator-independent availability cho hot path**, với reconciliation + fencing để xử lý sai lệch. Không đạt global strict safety dưới mọi partition; chấp nhận cửa sổ lease và bounded risk, bù bằng reconciliation/audit.

## 17. Không sở hữu

- **Provider cost** — ownership còn **OPEN** ([`open-boundaries.md`](../open-boundaries.md) OB-7); không có account, entry, payable hay type nào đại diện chi phí provider.
- **Payout execution** — `payout`/`payment` sở hữu; lib chỉ giữ `payout_evidence_ref` opaque.
- **Fiat payment** — deposit chỉ nhận `payment_reference` opaque; lib không khởi tạo/xác nhận giao dịch thanh toán (ADR-0003).
- **Tax calculation / withholding** — rate và legal category OPEN (ADR-0008); không có hàm tính thuế, không có state `tax withheld`.
- **Customer price / pricing policy** — `llm-seller-pricing` sở hữu; `settle` nhận `chargeAmount` và seller share do caller cấp.
- **Usage measurement** và **quota authority** — `llm-usage` và `llm-api` (A7).
- **Legal principal association / status** — `llm-seller-governance` sở hữu (ADR-0027 §3); settlement nhận **fact association** (seller có liên kết `FirstPartyLegalPrincipal` Ecoma-io hay không) làm input cho entitlement payable, có freshness bound — **trạng thái principal không phải input payable** (nó chỉ điều khiển serving eligibility, ADR-0027 §5); không đọc governance storage (ADR-0028 §7.1).
- **Tenant classification** — `llm-consumer-tenant` sở hữu; sponsor configuration không thể đọc, ghi hay suy ra nó (khác DB, khác bề mặt — ADR-0028 §3.1).
- **Định danh permission cho thao tác sponsor/ceiling** — thuộc catalog `staff-access`/backoffice chưa chốt; không phát minh tại đây (ADR-0028 §13.5).

## 18. Quyết định còn OPEN

1. **Conversion ratio và fee** (ADR-0005, ADR-0006): lib nhận `ratio` từ caller, không mặc định 1:1, không áp fee.
2. **Provider cost ownership** ([`open-boundaries.md`](../open-boundaries.md) OB-7): chưa gán cho context nào.
3. **Tax withholding rate** (ADR-0008): chưa có rate/legal category.
4. **Overdraft**: ADR-0004 loại trừ âm balance; không có cờ overdraft, mở lại quyết định này là thay đổi contract.
5. **Chuyển đổi currency của pricing schedule sang denomination VND**: chưa có hợp đồng; cho tới khi có, financial admission fail closed với schedule không express được giá ở VND — fallback đổi currency giữa các offer chưa được phép (ADR-0028 §13.4).
6. **Provisioning billing account cho tenant customer ngoài bootstrap**: thuộc cơ chế crediting `payment`↔`llm` còn mở (OB-1) (ADR-0028 §6).

**Quy tắc:** không một quyết định nào ở trên được âm thầm chốt trong code.

## 19. Ranh giới với các context khác

| Context                 | Ranh giới với `llm-financial`                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment`               | `payment` sở hữu fiat payment transaction, deposit initiation/confirmation, payment methods/providers, webhook verification, payment reconciliation, evidence of fiat received. `llm-financial` không đọc/ghi `db-payment` trực tiếp; mọi liên hệ đi qua contract/event.                                                                 |
| `payout`                | `payout` sở hữu seller payout request, quote, beneficiary/destination, fiat disbursement, manual payout MVP, execution evidence, payout reconciliation.                                                                                                                                                                                  |
| `llm-inference`         | `llm-inference` sở hữu logical request lifecycle và provider attempts; `llm-financial` không là quota authority và không sở hữu usage measurement.                                                                                                                                                                                       |
| `llm-usage`             | `llm-usage` sở hữu usage measurement. Usage ≠ financial charge.                                                                                                                                                                                                                                                                          |
| `llm-seller-pricing`    | Customer price/pricing policy thuộc `llm-seller-pricing`; `llm-financial` nhận giá bán làm input.                                                                                                                                                                                                                                        |
| `account`               | `sub` opaque; không FK xuyên DB.                                                                                                                                                                                                                                                                                                         |
| `staff-access`          | `staff-access` sở hữu staff identity/permission semantics; `llm-financial` không định nghĩa payout entitlement.                                                                                                                                                                                                                          |
| `llm-consumer-tenant`   | Billing account mang `tenant_ref` tham chiếu beneficiary opaque (R19); classification, membership và authorization thuộc consumer-tenant; sponsor configuration không đụng dữ liệu tenant (khác DB, khác bề mặt provisioning) (ADR-0028 §3).                                                                                             |
| `llm-seller-governance` | Fact association `FirstPartyLegalPrincipal` là dữ liệu governance; `llm-financial` tiêu thụ **fact association** (có liên kết hay không) qua Application (freshness bound) cho entitlement payable — không phải trạng thái principal (chỉ điều khiển serving eligibility); không sở hữu và không đọc storage governance (ADR-0028 §7.1). |

## 20. Tài liệu

| Document                               | Nội dung                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`domain-model.md`](./domain-model.md) | Business model, state machines, invariants, failure behavior, phân biệt các khái niệm tiền tệ |
| [`README.md`](./README.md)             | Tóm tắt phạm vi, không sở hữu, documents                                                      |
| [`adr/README.md`](./adr/README.md)     | ADR index (0001–0010, 0028) của bounded context                                               |
