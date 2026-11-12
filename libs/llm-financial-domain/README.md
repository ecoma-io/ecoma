# LLM Financial Domain

Tầng domain thuần của bounded context `llm-financial` (`@ecoma-io/llm-financial-domain`): billing account/wallet, double-entry ledger, reservation, settlement, seller payable, conversion, hold, budget escrow/lease, reconciliation và financial audit — tính đúng đắn tiền tệ của đường LLM.

Thư viện **không** import Nx project nào, **không** SQL, **không** Node builtin, **không** I/O; mọi tham số thời gian do caller truyền vào. Kết quả hàm trả `FinancialOk`/`FinancialFailure` thay vì ném exception cho dữ liệu đầu vào hỏng.

Nx project `@ecoma-io/llm-financial-domain`, tags `type:domain`, `scope:llm-shared`, `runtime:universal`.

## Purpose

- Tập trung monetary correctness — số dư suy từ ledger, reservation có fencing, settlement/payable có evidence — thành thư viện thuần dùng chung cho cả nhóm Consumer và Seller.
- Entry công khai duy nhất là `src/index.ts` (`main` của package).

## Responsibilities

Exports công khai (từ `src/index.ts`, nhóm chính):

- **Identifiers và refs** (`shared.ts`): `BillingAccountId`, `WalletId`, `LedgerTransactionId`, `LedgerEntryId`, `FencingToken`, `IdempotencyKey`, `AccountOwnerRef`/`TenantRef`/`ActorRef`/`PayoutEvidenceRef` với bộ `create*`/`is*` tương ứng, `FinancialOk`/`FinancialFailure`/`FinancialResult`.
- **Money** (`money.ts`): `DENOMINATIONS`, `LEDGER_UNIT`, `MAX_MONEY_MAGNITUDE`, `createMoney`, `addMoney`, `subtractMoney`, `compareMoney`, `sumMoney`, `readMoney` với `Money`/`UcAmount`/`EcAmount`.
- **Ledger** (`ledger.ts`): `LEDGER_ACCOUNTS`, `LEDGER_DIRECTIONS`, `LEDGER_REFERENCE_TYPES`, `createLedger`, `createLedgerTransaction`, `postTransaction` trả `PostTransactionOutcome`, `deriveWalletBalances`, `emptyBalances`.
- **Wallet và billing account** (`wallet.ts`): `createWallet`, `createBillingAccount`, `findWallet`, `findWalletByDenomination`, `checkWalletInvariant`, `WalletBalances`, `DEPOSIT_STATES`.
- **Book** (`book.ts`): aggregate `FinancialBook` — `openFinancialBook`, `addBillingAccount`, `locateWallet`, `commitTransaction`, `derivedTransactionId`, `derivedIdempotencyKey`, `withLedger`.
- **Records** (`records.ts`): vocabulary trạng thái `RESERVATION_STATES`, `CHARGE_STATES`, `PAYABLE_STATES`, `HOLD_SCOPES`, `LEASE_STATES`, `ESCROW_STATES`, `AUDIT_ACTIONS` cùng guard tương ứng; `refundableAmount`, `latestPayable`, `hasBlockingHold`, `referenceOf`.
- **Operations** (`reservation.ts`, `deposit.ts`, `settlement.ts`, `payable.ts`, `correction.ts`, `conversion.ts`, `hold.ts`, `escrow.ts`, `reconcile.ts`, `audit.ts`): `reserve`/`capture`/`release`, deposit, settlement, seller payable, correction, `convertEcToUc` (ratio do caller cấp), hold/escrow/lease, reconcile, `appendAudit`/`readAudit`.
- **Domain errors** (`errors.ts`): `LlmFinancialDomainErrorCode`, `LLM_FINANCIAL_DOMAIN_ERROR_MESSAGES` — message tiếng Anh.

Consumer trong workspace: `tools/dx/src/architecture/llm-boundaries.spec.ts` ghim ranh giới scope của các lib LLM theo đúng tên project này.

## Boundaries

- **Provider cost** — ownership còn mở (`docs/domains/open-boundaries.md` OB-7): không có account, ledger entry hay payable nào đại diện chi phí provider.
- **Payout execution** thuộc `payment`/`payout`; lib chỉ giữ `payout_evidence_ref` opaque và từ chối `paid` khi thiếu evidence. Fiat deposit chỉ nhận `payment_reference` opaque.
- **Customer price/pricing policy** thuộc `llm-seller-pricing` — settlement nhận `chargeAmount` và phần seller do caller cung cấp.
- Conversion ratio và fee để mở theo ADR-0005/ADR-0006: không default 1:1, không áp fee; tax withholding để mở theo ADR-0008; overdraft bị loại theo ADR-0004 (không có cờ âm balance).

## Development

```bash
pnpm nx run @ecoma-io/llm-financial-domain:lint
pnpm nx run @ecoma-io/llm-financial-domain:typecheck          # tsc --build --emitDeclarationOnly
```

Mã nguồn nằm dưới `src/`; thêm module mới = thêm file và spec colocated, rồi export qua `src/index.ts`.

## Testing

```bash
pnpm nx run @ecoma-io/llm-financial-domain:test               # vitest — spec colocated trong src/
```

Spec colocated theo module: `money.spec.ts`, `ledger.spec.ts`, `wallet.spec.ts`, `book.spec.ts`, `reservation.spec.ts`, `deposit.spec.ts`, `settlement.spec.ts`, `payable.spec.ts`, `correction.spec.ts`, `conversion.spec.ts`, `escrow.spec.ts`, `reconcile.spec.ts`, `index.spec.ts`.

## Related Documentation

- [`docs/domains/llm-financial/README.md`](../../docs/domains/llm-financial/README.md) — bounded context; [`domain-model.md`](../../docs/domains/llm-financial/domain-model.md) — ledger, reservation, settlement, reconciliation.
- [`docs/domains/llm-financial/adr/`](../../docs/domains/llm-financial/adr/) — ADR-0003 (financial ownership), ADR-0004 (double-entry, không overdraft), ADR-0005/0006 (conversion), ADR-0007 (settlement holds), ADR-0008 (tax profile).
- [`docs/domains/open-boundaries.md`](../../docs/domains/open-boundaries.md) — OB-1 (crediting với `payment`), OB-7 (provider cost).
- [`docs/architecture/05-code-architecture.md`](../../docs/architecture/05-code-architecture.md) — §6.3 scope `llm-shared`, §3 dependency direction.
